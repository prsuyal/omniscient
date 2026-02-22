import path from "node:path";

import { env } from "~/env";
import { runPythonBridge } from "~/server/simulation/pythonBridge";

export type Stage2FeatureVector = {
  age: number;
  row_id: string;
  year_index?: number;
  sample_index?: number;
  [key: string]: string | number | null | undefined;
};

export type Stage2RiskRow = {
  age: number;
  row_id?: string;
  year_index?: number;
  sample_index?: number;
  risks: Record<string, number>;
};

export type Stage2AdapterResult = {
  diseases: string[];
  rows: Stage2RiskRow[];
};

const resolveMaybeRelative = (value: string): string => {
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
};

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const sanitizeRows = (rows: Stage2FeatureVector[]): Stage2FeatureVector[] =>
  rows.map((row, idx) => {
    const cleaned: Stage2FeatureVector = {
      age: toFiniteNumber(row.age, 0),
      row_id: row.row_id || `row-${idx}`,
      year_index: row.year_index,
      sample_index: row.sample_index,
    };

    for (const [key, value] of Object.entries(row)) {
      if (["age", "row_id", "year_index", "sample_index"].includes(key)) continue;

      if (value == null) {
        cleaned[key] = null;
        continue;
      }

      if (typeof value === "number") {
        cleaned[key] = Number.isFinite(value) ? value : null;
        continue;
      }

      if (typeof value === "string") {
        cleaned[key] = value;
      }
    }

    return cleaned;
  });

const normalizeResult = (raw: unknown): Stage2AdapterResult => {
  const parsed = raw as {
    diseases?: unknown;
    rows?: Array<{
      age?: unknown;
      row_id?: unknown;
      year_index?: unknown;
      sample_index?: unknown;
      risks?: Record<string, unknown>;
    }>;
  };

  const diseases = Array.isArray(parsed.diseases)
    ? parsed.diseases
        .map((disease) => (typeof disease === "string" ? disease : String(disease)))
        .filter((value) => value.trim().length > 0)
    : [];

  const rows: Stage2RiskRow[] = (parsed.rows ?? []).map((row, idx) => {
    const risks: Record<string, number> = {};
    for (const [disease, value] of Object.entries(row.risks ?? {})) {
      const risk = toFiniteNumber(value, 0);
      risks[disease] = Math.max(0, Math.min(1, risk));
    }

    return {
      age: toFiniteNumber(row.age, 0),
      row_id: typeof row.row_id === "string" ? row.row_id : `row-${idx}`,
      year_index: row.year_index == null ? undefined : Math.round(toFiniteNumber(row.year_index, idx)),
      sample_index: row.sample_index == null ? undefined : Math.round(toFiniteNumber(row.sample_index, 0)),
      risks,
    };
  });

  return {
    diseases,
    rows,
  };
};

export const runStage2Risks = async (
  featuresByYear: Stage2FeatureVector[],
  diseases?: string[],
): Promise<Stage2AdapterResult> => {
  const payload = {
    mode: "stage2",
    model_dir: resolveMaybeRelative(env.STAGE2_MODEL_DIR),
    diseases,
    features_by_year: sanitizeRows(featuresByYear),
  };

  const result = await runPythonBridge<unknown>(payload);
  return normalizeResult(result);
};
