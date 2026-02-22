import path from "node:path";

import { env } from "~/env";
import { runPythonBridge } from "~/server/simulation/pythonBridge";
import { type CanonicalUserInput } from "~/server/simulation/schemas";

type Stage1SimConfig = {
  startAge: number;
  endAge: number;
  nSimulations?: number;
  seed?: number;
};

export type Stage1TrajectoryPoint = {
  age: number;
  biomarkers: Record<
    string,
    {
      mean: number;
      p05: number | null;
      p50: number | null;
      p95: number | null;
      base_sigma: number;
      sigma_total: number;
    }
  >;
};

export type Stage1TrajectoryResult = {
  startAge: number;
  endAge: number;
  trajectory: Stage1TrajectoryPoint[];
};

const resolveMaybeRelative = (value: string): string => {
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
};

// Placeholder fallback sigmas by biomarker when stage1 only returns point estimates.
const DEFAULT_BIOMARKER_BASE_SIGMA: Record<string, number> = {
  bmi: 1.4,
  systolic_bp: 8.5,
  diastolic_bp: 5.5,
  resting_hr: 7.0,
  ldl: 15.0,
  hdl: 8.0,
  total_cholesterol: 22.0,
  hba1c: 0.45,
  egfr: 9.0,
  crp: 1.2,
  height_cm: 1.5,
  pir: 0.35,
  sleep_hours: 0.9,
  diet_quality_indicator: 0.45,
  alcohol_drinks_per_day: 0.8,
  pa_minutes_week: 70,
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const ensureTrajectoryShape = (raw: unknown): Stage1TrajectoryResult => {
  const asObject = raw as {
    startAge?: number;
    endAge?: number;
    trajectory?: Array<{
      age?: number;
      biomarkers?: Record<string, unknown>;
    }>;
  };

  const startAge = Math.round(toFiniteNumber(asObject.startAge, 40));
  const endAge = Math.round(toFiniteNumber(asObject.endAge, Math.max(startAge + 1, 80)));

  const trajectory = (asObject.trajectory ?? []).map((yearPoint, index) => {
    const age = Math.round(toFiniteNumber(yearPoint.age, startAge + index));
    const biomarkers: Stage1TrajectoryPoint["biomarkers"] = {};

    for (const [biomarker, maybeValue] of Object.entries(yearPoint.biomarkers ?? {})) {
      if (typeof maybeValue === "number") {
        const mean = toFiniteNumber(maybeValue, 0);
        const fallbackSigma = DEFAULT_BIOMARKER_BASE_SIGMA[biomarker] ?? 0.75;
        biomarkers[biomarker] = {
          mean,
          p05: null,
          p50: null,
          p95: null,
          base_sigma: fallbackSigma,
          sigma_total: fallbackSigma,
        };
        continue;
      }

      const asPoint = maybeValue as {
        mean?: unknown;
        p05?: unknown;
        p50?: unknown;
        p95?: unknown;
        base_sigma?: unknown;
        sigma_total?: unknown;
      };

      const mean = toFiniteNumber(asPoint.mean, 0);
      const fallbackSigma = DEFAULT_BIOMARKER_BASE_SIGMA[biomarker] ?? 0.75;
      const baseSigma = Math.max(0.01, toFiniteNumber(asPoint.base_sigma, fallbackSigma));

      biomarkers[biomarker] = {
        mean,
        p05: asPoint.p05 == null ? null : toFiniteNumber(asPoint.p05, mean),
        p50: asPoint.p50 == null ? null : toFiniteNumber(asPoint.p50, mean),
        p95: asPoint.p95 == null ? null : toFiniteNumber(asPoint.p95, mean),
        base_sigma: baseSigma,
        sigma_total: Math.max(0.01, toFiniteNumber(asPoint.sigma_total, baseSigma)),
      };
    }

    return {
      age,
      biomarkers,
    };
  });

  return {
    startAge,
    endAge,
    trajectory,
  };
};

export const simulateStage1Trajectory = async (
  input: CanonicalUserInput,
  config: Stage1SimConfig,
): Promise<Stage1TrajectoryResult> => {
  const payload = {
    mode: "stage1",
    canonical_input: input,
    model_artifact: resolveMaybeRelative(env.STAGE1_MODEL_ARTIFACT),
    start_age: config.startAge,
    end_age: config.endAge,
    n_simulations: config.nSimulations ?? 500,
    seed: config.seed ?? 42,
  };

  const result = await runPythonBridge<unknown>(payload);
  return ensureTrajectoryShape(result);
};
