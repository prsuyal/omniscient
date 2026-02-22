import { readFile } from "node:fs/promises";

import { parse } from "csv-parse/sync";

import { env } from "~/env";
import type { Stage1Output } from "~/server/simulation/schemas";

type MetricRow = {
  biomarker: string;
  mean_wasserstein: number | null;
  mean_model_rmse: number | null;
  variance_pass_rate: number | null;
};

type UncertaintyScore = {
  mean_wasserstein: number | null;
  mean_model_rmse: number | null;
  variance_pass_rate: number | null;
  error_score: number;
  sigma_model: number;
};

export type UncertaintyConfig = {
  a: number;
  b: number;
  c: number;
  lambda: number;
  horizonWidening: "sqrt" | "linear";
};

export const DEFAULT_UNCERTAINTY_CONFIG: UncertaintyConfig = {
  a: env.UNCERTAINTY_A,
  b: env.UNCERTAINTY_B,
  c: env.UNCERTAINTY_C,
  lambda: env.UNCERTAINTY_LAMBDA,
  horizonWidening: env.UNCERTAINTY_HORIZON,
};

const toNullableNumber = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
};

const minMaxNormalize = (value: number | null, min: number, max: number): number => {
  if (value == null || !Number.isFinite(value)) return 0;
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
};

const horizonFactor = (horizonYears: number, mode: UncertaintyConfig["horizonWidening"]): number => {
  const h = Math.max(0, horizonYears);
  if (mode === "linear") return h;
  return Math.sqrt(h);
};

const gatherMinMax = (rows: MetricRow[], key: keyof Pick<MetricRow, "mean_wasserstein" | "mean_model_rmse">) => {
  const values = rows
    .map((row) => row[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (!values.length) return { min: 0, max: 1 };

  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
};

export const loadBiomarkerMetrics = async (csvPath: string): Promise<Record<string, MetricRow>> => {
  const raw = await readFile(csvPath, "utf8");
  const records: unknown[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const output: Record<string, MetricRow> = {};

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const row = record as Record<string, unknown>;
    const biomarker = typeof row.biomarker === "string" ? row.biomarker.trim() : "";
    if (!biomarker) continue;

    output[biomarker] = {
      biomarker,
      mean_wasserstein: toNullableNumber(row.mean_wasserstein),
      mean_model_rmse: toNullableNumber(row.mean_model_rmse),
      variance_pass_rate: toNullableNumber(row.variance_pass_rate),
    };
  }

  return output;
};

export const computeUncertaintyScores = (
  metricsByBiomarker: Record<string, MetricRow>,
  config: UncertaintyConfig,
): Record<string, UncertaintyScore> => {
  const rows = Object.values(metricsByBiomarker);
  const wassersteinRange = gatherMinMax(rows, "mean_wasserstein");
  const rmseRange = gatherMinMax(rows, "mean_model_rmse");

  const output: Record<string, UncertaintyScore> = {};

  for (const [biomarker, metrics] of Object.entries(metricsByBiomarker)) {
    const normWasserstein = minMaxNormalize(
      metrics.mean_wasserstein,
      wassersteinRange.min,
      wassersteinRange.max,
    );
    const normRmse = minMaxNormalize(metrics.mean_model_rmse, rmseRange.min, rmseRange.max);

    const variancePassRate =
      metrics.variance_pass_rate == null
        ? 0
        : Math.max(0, Math.min(1, metrics.variance_pass_rate));

    const errorScore =
      config.a * normWasserstein +
      config.b * normRmse +
      config.c * (1 - variancePassRate);

    const sigmaModel = Math.max(0, config.lambda * errorScore);

    output[biomarker] = {
      mean_wasserstein: metrics.mean_wasserstein,
      mean_model_rmse: metrics.mean_model_rmse,
      variance_pass_rate: metrics.variance_pass_rate,
      error_score: errorScore,
      sigma_model: sigmaModel,
    };
  }

  return output;
};

export const sigmaTotalForYear = (
  baseSigma: number,
  sigmaModel: number,
  horizonYears: number,
  config: UncertaintyConfig,
): number => {
  const safeBase = Number.isFinite(baseSigma) ? Math.max(0.001, baseSigma) : 0.001;
  const safeModel = Number.isFinite(sigmaModel) ? Math.max(0, sigmaModel) : 0;
  const g = horizonFactor(horizonYears, config.horizonWidening);

  return Math.sqrt(safeBase ** 2 + (safeModel ** 2) * g ** 2);
};

export const widenTrajectoryUncertainty = (
  trajectory: Stage1Output["trajectory"],
  scoresByBiomarker: Record<string, UncertaintyScore>,
  startAge: number,
  config: UncertaintyConfig,
): Stage1Output["trajectory"] => {
  return trajectory.map((point) => {
    const horizonYears = Math.max(0, point.age - startAge);

    const biomarkers = Object.fromEntries(
      Object.entries(point.biomarkers).map(([biomarker, values]) => {
        const score = scoresByBiomarker[biomarker]?.sigma_model ?? 0;
        const sigmaTotal = sigmaTotalForYear(values.base_sigma, score, horizonYears, config);

        return [
          biomarker,
          {
            ...values,
            base_sigma: Math.max(0.001, values.base_sigma),
            sigma_total: sigmaTotal,
          },
        ];
      }),
    );

    return {
      ...point,
      biomarkers,
    };
  });
};
