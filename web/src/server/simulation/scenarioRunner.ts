import { createHash } from "node:crypto";
import path from "node:path";

import { env } from "~/env";
import { computeConfidenceScores } from "~/server/simulation/confidence";
import type {
  CanonicalUserInput,
  ModifierDefinition,
  ScenarioComparison,
  Stage2Output,
} from "~/server/simulation/schemas";
import { stage1OutputSchema, stage2OutputSchema } from "~/server/simulation/schemas";
import { simulateStage1Trajectory } from "~/server/simulation/stage1Adapter";
import { runStage2Risks, type Stage2FeatureVector } from "~/server/simulation/stage2Adapter";
import {
  computeUncertaintyScores,
  DEFAULT_UNCERTAINTY_CONFIG,
  loadBiomarkerMetrics,
  widenTrajectoryUncertainty,
} from "~/server/simulation/uncertainty";
import { computeUnifiedHealthIndex } from "~/server/simulation/unifiedIndex";

type DerivedFeatureOverrides = {
  current_smoker?: number;
  former_smoker?: number;
  medication_use?: number;
};

type ScenarioRunnerConfig = {
  startAge: number;
  endAge: number;
  monteCarloSamples: number;
};

export type ScenarioRunResult = {
  canonicalInput: CanonicalUserInput;
  stage1: ReturnType<typeof stage1OutputSchema.parse>;
  stage2: Stage2Output;
  unifiedIndex: ReturnType<typeof computeUnifiedHealthIndex>;
  confidence: ReturnType<typeof computeConfidenceScores>;
  cacheKey: string;
};

const PHYSIOLOGIC_BOUNDS: Record<string, { min: number; max: number }> = {
  "body.bmi": { min: 10, max: 80 },
  "vitals.sbp": { min: 70, max: 250 },
  "vitals.resting_hr": { min: 30, max: 220 },
  "labs.ldl": { min: 0, max: 320 },
  "labs.hdl": { min: 0, max: 180 },
  "labs.total_cholesterol": { min: 50, max: 500 },
  "labs.hba1c": { min: 3, max: 16 },
  "labs.egfr": { min: 0, max: 130 },
  "behaviors.sleep_hours": { min: 0, max: 24 },
  "behaviors.alcohol_drinks_per_day": { min: 0, max: 40 },
  "behaviors.pa_minutes_week": { min: 0, max: 20000 },
  "behaviors.diet_quality_indicator": { min: -5, max: 5 },
  "nutrition.diet_quality_indicator": { min: 0, max: 100 },
  "nutrition.sugary_drinks_per_week": { min: 0, max: 70 },
};

const BIOMARKER_TO_FEATURE: Record<string, string> = {
  bmi: "bmi",
  systolic_bp: "systolic_bp",
  diastolic_bp: "diastolic_bp",
  resting_hr: "resting_hr",
  ldl: "ldl",
  hdl: "hdl",
  total_cholesterol: "total_cholesterol",
  hba1c: "hba1c",
  egfr: "egfr",
  crp: "crp",
  height_cm: "height_cm",
  pir: "pir",
  sleep_hours: "sleep_hours",
  diet_quality_indicator: "diet_quality_indicator",
  alcohol_drinks_per_day: "alcohol_drinks_per_day",
  pa_minutes_week: "pa_minutes_week",
};

const STAGE2_PHYSIOLOGIC_BOUNDS: Record<string, { min: number; max: number }> = {
  bmi: { min: 10, max: 80 },
  systolic_bp: { min: 70, max: 250 },
  diastolic_bp: { min: 35, max: 150 },
  resting_hr: { min: 30, max: 220 },
  ldl: { min: 0, max: 320 },
  hdl: { min: 0, max: 180 },
  total_cholesterol: { min: 50, max: 500 },
  hba1c: { min: 3, max: 16 },
  egfr: { min: 0, max: 130 },
  crp: { min: 0, max: 100 },
  sleep_hours: { min: 0, max: 24 },
  alcohol_drinks_per_day: { min: 0, max: 40 },
  pa_minutes_week: { min: 0, max: 20000 },
  diet_quality_indicator: { min: -5, max: 5 },
};

const scenarioCache = new Map<string, ScenarioRunResult>();
const inFlightScenarioCache = new Map<string, Promise<ScenarioRunResult>>();
let cachedMetricsPromise: Promise<Record<string, Awaited<ReturnType<typeof loadBiomarkerMetrics>>[string]>> | null = null;

const SCENARIO_PERF_LIMITS = {
  // Keep interactive baseline latencies bounded while preserving stochastic signal.
  stage1SimulationCountMin: 120,
  stage1SimulationCountMax: 320,
  stage2MinMonteCarloSamples: 20,
  stage2MaxMonteCarloRows: 36_000,
  stage2DeterministicBatchSize: 1_500,
  stage2MonteCarloBatchSize: 2_200,
} as const;

const resolvePath = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(process.cwd(), value));

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const cumulativeEventProbability = (previous: number, yearlyProbability: number): number => {
  const prev = clamp(previous, 0, 1);
  const current = clamp(yearlyProbability, 0, 1);
  return clamp(1 - (1 - prev) * (1 - current), 0, 1);
};

const deepCloneCanonical = (canonicalInput: CanonicalUserInput): CanonicalUserInput => {
  return JSON.parse(JSON.stringify(canonicalInput)) as CanonicalUserInput;
};

const getAtPath = (record: unknown, pathKey: string): unknown => {
  return pathKey.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, record);
};

const setAtPath = (record: unknown, pathKey: string, value: unknown): void => {
  const keys = pathKey.split(".");
  let current = record as Record<string, unknown>;

  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!key) continue;

    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }

    current = current[key] as Record<string, unknown>;
  }

  const terminalKey = keys[keys.length - 1];
  if (!terminalKey) return;
  current[terminalKey] = value;
};

const toFiniteNumber = (value: unknown): number | null => {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
};

const inferSmokingFlags = (canonicalInput: CanonicalUserInput): { currentSmoker: number; formerSmoker: number } => {
  const combinedText = [
    canonicalInput.histories.addiction_history_text,
    canonicalInput.histories.personal_history_text,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  const hasSmokingWord = /(smok|cigarette|tobacco|vape)/.test(combinedText);
  const formerSignal = /(former smoker|quit smoking|quit tobacco|stopped smoking)/.test(combinedText);

  if (!hasSmokingWord) {
    return { currentSmoker: 0, formerSmoker: 0 };
  }

  if (formerSignal) {
    return { currentSmoker: 0, formerSmoker: 1 };
  }

  return { currentSmoker: 1, formerSmoker: 0 };
};

const applyModifierDeltas = (
  canonicalInput: CanonicalUserInput,
  activeModifiers: ModifierDefinition[],
): { canonicalInput: CanonicalUserInput; overrides: DerivedFeatureOverrides } => {
  const next = deepCloneCanonical(canonicalInput);
  const overrides: DerivedFeatureOverrides = {};

  for (const modifier of activeModifiers) {
    if (modifier.category === "medication_prescribed") {
      overrides.medication_use = 1;
    }

    for (const [pathKey, deltaRaw] of Object.entries(modifier.deltas)) {
      const delta = Number.isFinite(deltaRaw) ? deltaRaw : 0;

      if (pathKey.startsWith("derived.")) {
        const overrideKey = pathKey.replace("derived.", "") as keyof DerivedFeatureOverrides;
        const current = overrides[overrideKey] ?? 0;
        overrides[overrideKey] = current + delta;
        continue;
      }

      const currentValue = toFiniteNumber(getAtPath(next, pathKey));
      const defaultBase = pathKey === "nutrition.diet_quality_indicator" ? 50 : 0;
      const updated = (currentValue ?? defaultBase) + delta;

      const bounds = PHYSIOLOGIC_BOUNDS[pathKey];
      const bounded = bounds ? clamp(updated, bounds.min, bounds.max) : updated;
      setAtPath(next, pathKey, bounded);
    }
  }

  return {
    canonicalInput: next,
    overrides,
  };
};

const randomNormal = (): number => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);

  if (lo === hi) return sorted[lo] ?? Number.NaN;
  const loVal = sorted[lo] ?? Number.NaN;
  const hiVal = sorted[hi] ?? Number.NaN;
  return loVal + (hiVal - loVal) * (idx - lo);
};

const toCumulativeRiskYears = (
  years: Array<{
    age: number;
    deterministic: Record<string, number>;
    uncertainty: Record<string, { mean: number; median: number; p05: number; p95: number }>;
  }>,
) => {
  const deterministicTracker: Record<string, number> = {};
  const uncertaintyTracker: Record<
    string,
    { mean: number; median: number; p05: number; p95: number }
  > = {};

  return years.map((year) => {
    const deterministic: Record<string, number> = {};
    for (const [disease, risk] of Object.entries(year.deterministic)) {
      const previous = deterministicTracker[disease] ?? 0;
      const cumulative = cumulativeEventProbability(previous, risk);
      deterministic[disease] = cumulative;
      deterministicTracker[disease] = cumulative;
    }

    const uncertainty: Record<string, { mean: number; median: number; p05: number; p95: number }> = {};
    for (const [disease, stats] of Object.entries(year.uncertainty)) {
      const previous = uncertaintyTracker[disease] ?? { mean: 0, median: 0, p05: 0, p95: 0 };

      const nextStats = {
        mean: cumulativeEventProbability(previous.mean, stats.mean),
        median: cumulativeEventProbability(previous.median, stats.median),
        p05: cumulativeEventProbability(previous.p05, stats.p05),
        p95: cumulativeEventProbability(previous.p95, stats.p95),
      };

      uncertainty[disease] = nextStats;
      uncertaintyTracker[disease] = nextStats;
    }

    return {
      age: year.age,
      deterministic,
      uncertainty,
    };
  });
};

const deriveStage2BaseFeatures = (canonicalInput: CanonicalUserInput, overrides: DerivedFeatureOverrides) => {
  const smoking = inferSmokingFlags(canonicalInput);

  return {
    sex: canonicalInput.demographics.sex ?? "Unknown",
    race_ethnicity: canonicalInput.demographics.race_ethnicity ?? "Unknown",
    region_proxy: 0,
    pir: canonicalInput.demographics.ses_pir,
    height_cm: canonicalInput.body.height_cm,
    bmi: canonicalInput.body.bmi,
    systolic_bp: canonicalInput.vitals.sbp,
    resting_hr: canonicalInput.vitals.resting_hr,
    ldl: canonicalInput.labs.ldl,
    hdl: canonicalInput.labs.hdl,
    total_cholesterol: canonicalInput.labs.total_cholesterol,
    hba1c: canonicalInput.labs.hba1c,
    egfr: canonicalInput.labs.egfr,
    sleep_hours: canonicalInput.behaviors.sleep_hours,
    alcohol_drinks_per_day: canonicalInput.behaviors.alcohol_drinks_per_day,
    pa_minutes_week: canonicalInput.behaviors.pa_minutes_week,
    diet_quality_indicator: canonicalInput.behaviors.diet_quality_indicator,
    current_smoker: clamp(
      Math.round(overrides.current_smoker ?? smoking.currentSmoker),
      0,
      1,
    ),
    former_smoker: clamp(
      Math.round(overrides.former_smoker ?? smoking.formerSmoker),
      0,
      1,
    ),
    alcohol_use:
      canonicalInput.behaviors.alcohol_drinks_per_day != null
        ? Number(canonicalInput.behaviors.alcohol_drinks_per_day > 0)
        : 0,
    physically_active:
      canonicalInput.behaviors.pa_minutes_week != null
        ? Number(canonicalInput.behaviors.pa_minutes_week > 0)
        : 0,
    medication_use:
      overrides.medication_use ?? (canonicalInput.medications_text ? 1 : 0),
    family_history_heart: canonicalInput.histories.family_history_text ? 1 : 0,
    family_history_asthma: 0,
    family_history_diabetes: 0,
    pre_hypertension:
      canonicalInput.vitals.sbp != null ? Number(canonicalInput.vitals.sbp >= 120 && canonicalInput.vitals.sbp < 130) : 0,
    pre_diabetes:
      canonicalInput.labs.hba1c != null
        ? Number(canonicalInput.labs.hba1c >= 5.7 && canonicalInput.labs.hba1c < 6.5)
        : 0,
  } satisfies Record<string, string | number | null>;
};

const buildFeatureRowsForDeterministic = (
  canonicalInput: CanonicalUserInput,
  trajectory: ReturnType<typeof stage1OutputSchema.parse>["trajectory"],
  overrides: DerivedFeatureOverrides,
): Stage2FeatureVector[] => {
  const base = deriveStage2BaseFeatures(canonicalInput, overrides);

  return trajectory.map((point, index) => {
    const row: Stage2FeatureVector = {
      ...base,
      age: point.age,
      row_id: `det-${index}`,
      year_index: index,
      sample_index: 0,
    };

    for (const [biomarker, values] of Object.entries(point.biomarkers)) {
      const featureName = BIOMARKER_TO_FEATURE[biomarker] ?? biomarker;
      row[featureName] = values.mean;
    }

    return row;
  });
};

const buildFeatureRowsForMonteCarlo = (
  canonicalInput: CanonicalUserInput,
  trajectory: ReturnType<typeof stage1OutputSchema.parse>["trajectory"],
  nSamples: number,
  overrides: DerivedFeatureOverrides,
): Stage2FeatureVector[] => {
  const base = deriveStage2BaseFeatures(canonicalInput, overrides);
  const rows: Stage2FeatureVector[] = [];

  for (let yearIndex = 0; yearIndex < trajectory.length; yearIndex += 1) {
    const point = trajectory[yearIndex];
    if (!point) continue;

    for (let sampleIndex = 0; sampleIndex < nSamples; sampleIndex += 1) {
      const row: Stage2FeatureVector = {
        ...base,
        age: point.age,
        row_id: `mc-${yearIndex}-${sampleIndex}`,
        year_index: yearIndex,
        sample_index: sampleIndex,
      };

      for (const [biomarker, values] of Object.entries(point.biomarkers)) {
        const sampled = values.mean + randomNormal() * values.sigma_total;
        const featureName = BIOMARKER_TO_FEATURE[biomarker] ?? biomarker;
        const bounds = STAGE2_PHYSIOLOGIC_BOUNDS[featureName];
        row[featureName] = bounds ? clamp(sampled, bounds.min, bounds.max) : sampled;
      }

      rows.push(row);
    }
  }

  return rows;
};

const runStage2InBatches = async (rows: Stage2FeatureVector[], chunkSize = 2_500) => {
  const allRows: Array<{ age: number; year_index?: number; sample_index?: number; risks: Record<string, number> }> = [];
  let diseases: string[] = [];

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const result = await runStage2Risks(chunk, diseases.length ? diseases : undefined);
    if (!diseases.length) diseases = result.diseases;
    allRows.push(...result.rows);
  }

  return { diseases, rows: allRows };
};

const loadMetricsCached = async () => {
  cachedMetricsPromise ??= loadBiomarkerMetrics(resolvePath(env.STAGE1_METRICS_PATH));

  return await cachedMetricsPromise;
};

const computeScenarioHash = (input: {
  canonicalInput: CanonicalUserInput;
  activeModifierIds: string[];
  modifiers: ModifierDefinition[];
  config: ScenarioRunnerConfig;
}): string => {
  const activeSet = new Set(input.activeModifierIds);

  const selectedModifierDeltas = input.modifiers
    .filter((modifier) => activeSet.has(modifier.id))
    .map((modifier) => ({ id: modifier.id, deltas: modifier.deltas }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return createHash("sha256")
    .update(
      JSON.stringify({
        canonicalInput: input.canonicalInput,
        selectedModifierDeltas,
        startAge: input.config.startAge,
        endAge: input.config.endAge,
        monteCarloSamples: input.config.monteCarloSamples,
      }),
    )
    .digest("hex");
};

const runScenario = async (input: {
  canonicalInput: CanonicalUserInput;
  activeModifierIds: string[];
  modifiers: ModifierDefinition[];
  config: ScenarioRunnerConfig;
}): Promise<ScenarioRunResult> => {
  const activeSet = new Set(input.activeModifierIds);
  const activeModifiers = input.modifiers.filter((modifier) => activeSet.has(modifier.id));

  const { canonicalInput, overrides } = applyModifierDeltas(input.canonicalInput, activeModifiers);
  const stage1SimulationCount = clamp(
    Math.round(input.config.monteCarloSamples),
    SCENARIO_PERF_LIMITS.stage1SimulationCountMin,
    SCENARIO_PERF_LIMITS.stage1SimulationCountMax,
  );

  const stage1Raw = await simulateStage1Trajectory(canonicalInput, {
    startAge: input.config.startAge,
    endAge: input.config.endAge,
    nSimulations: stage1SimulationCount,
    seed: 42,
  });

  const metricsByBiomarker = await loadMetricsCached();
  const uncertaintyScores = computeUncertaintyScores(metricsByBiomarker, DEFAULT_UNCERTAINTY_CONFIG);

  const stage1 = stage1OutputSchema.parse({
    ...stage1Raw,
    trajectory: widenTrajectoryUncertainty(
      stage1Raw.trajectory,
      uncertaintyScores,
      input.config.startAge,
      DEFAULT_UNCERTAINTY_CONFIG,
    ),
    metricScoreByBiomarker: uncertaintyScores,
  });

  const trajectoryLength = stage1.trajectory.length;
  const maxSamplesByRowBudget = Math.max(
    SCENARIO_PERF_LIMITS.stage2MinMonteCarloSamples,
    Math.floor(SCENARIO_PERF_LIMITS.stage2MaxMonteCarloRows / Math.max(trajectoryLength, 1)),
  );
  const effectiveMonteCarloSamples = clamp(
    input.config.monteCarloSamples,
    SCENARIO_PERF_LIMITS.stage2MinMonteCarloSamples,
    maxSamplesByRowBudget,
  );

  const deterministicRows = buildFeatureRowsForDeterministic(canonicalInput, stage1.trajectory, overrides);
  const deterministicResult = await runStage2InBatches(
    deterministicRows,
    SCENARIO_PERF_LIMITS.stage2DeterministicBatchSize,
  );

  const monteCarloRows = buildFeatureRowsForMonteCarlo(
    canonicalInput,
    stage1.trajectory,
    effectiveMonteCarloSamples,
    overrides,
  );
  const mcResult = await runStage2InBatches(
    monteCarloRows,
    SCENARIO_PERF_LIMITS.stage2MonteCarloBatchSize,
  );

  const yearRiskMap = new Map<
    number,
    {
      age: number;
      deterministic: Record<string, number>;
      samples: Record<string, number[]>;
    }
  >();

  for (const row of deterministicResult.rows) {
    const yearIndex = row.year_index ?? 0;
    const current = yearRiskMap.get(yearIndex) ?? {
      age: row.age,
      deterministic: {},
      samples: {},
    };

    current.deterministic = row.risks;
    yearRiskMap.set(yearIndex, current);
  }

  for (const row of mcResult.rows) {
    const yearIndex = row.year_index ?? 0;
    const current = yearRiskMap.get(yearIndex) ?? {
      age: row.age,
      deterministic: {},
      samples: {},
    };

    for (const disease of Object.keys(row.risks)) {
      current.samples[disease] ??= [];
      current.samples[disease].push(row.risks[disease] ?? 0);
    }

    yearRiskMap.set(yearIndex, current);
  }

  const years = [...yearRiskMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, yearData]) => {
      const uncertainty: Record<string, { mean: number; median: number; p05: number; p95: number }> = {};

      for (const [disease, values] of Object.entries(yearData.samples)) {
        uncertainty[disease] = {
          mean: values.reduce((acc, value) => acc + value, 0) / Math.max(values.length, 1),
          median: quantile(values, 0.5),
          p05: quantile(values, 0.05),
          p95: quantile(values, 0.95),
        };
      }

      return {
        age: yearData.age,
        deterministic: yearData.deterministic,
        uncertainty,
      };
    });

  const stage2 = stage2OutputSchema.parse({
    diseases: deterministicResult.diseases,
    years: toCumulativeRiskYears(years),
  });

  const unifiedIndex = computeUnifiedHealthIndex({
    canonicalInput,
    stage1,
    stage2,
  });

  const confidence = computeConfidenceScores({
    canonicalInput,
    stage1,
    stage2,
  });

  const cacheKey = computeScenarioHash(input);

  return {
    canonicalInput,
    stage1,
    stage2,
    unifiedIndex,
    confidence,
    cacheKey,
  };
};

const horizonRisks = (stage2: Stage2Output): Record<string, number> => {
  const horizonYear = stage2.years[stage2.years.length - 1];
  return horizonYear?.deterministic ?? {};
};

const toScenarioComparison = (
  baseline: ScenarioRunResult,
  scenario: ScenarioRunResult,
  activeModifierIds: string[],
): ScenarioComparison => {
  const baselineHorizon = horizonRisks(baseline.stage2);
  const scenarioHorizon = horizonRisks(scenario.stage2);
  const diseaseSet = new Set([...Object.keys(baselineHorizon), ...Object.keys(scenarioHorizon)]);

  const risk_delta_by_disease_at_horizon = Object.fromEntries(
    [...diseaseSet].map((disease) => [
      disease,
      (baselineHorizon[disease] ?? 0) - (scenarioHorizon[disease] ?? 0),
    ]),
  );

  return {
    active_modifier_ids: [...activeModifierIds].sort(),
    stage2: scenario.stage2,
    unified_index: scenario.unifiedIndex,
    confidence: scenario.confidence,
    risk_delta_by_disease_at_horizon,
    unified_index_delta: scenario.unifiedIndex.value - baseline.unifiedIndex.value,
  };
};

export const runScenarioWithCaching = async (input: {
  canonicalInput: CanonicalUserInput;
  activeModifierIds: string[];
  modifiers: ModifierDefinition[];
  config: ScenarioRunnerConfig;
}): Promise<ScenarioRunResult> => {
  const cacheKey = computeScenarioHash(input);
  const cached = scenarioCache.get(cacheKey);
  if (cached) return cached;

  const inFlight = inFlightScenarioCache.get(cacheKey);
  if (inFlight) {
    return await inFlight;
  }

  const pending = runScenario(input)
    .then((scenario) => {
      scenarioCache.set(cacheKey, scenario);
      return scenario;
    })
    .finally(() => {
      inFlightScenarioCache.delete(cacheKey);
    });

  inFlightScenarioCache.set(cacheKey, pending);
  return await pending;
};

export const runScenarioComparisonWithCaching = async (input: {
  canonicalInput: CanonicalUserInput;
  baseline: ScenarioRunResult;
  activeModifierIds: string[];
  modifiers: ModifierDefinition[];
  config: ScenarioRunnerConfig;
}): Promise<{ scenario: ScenarioRunResult; comparison: ScenarioComparison }> => {
  const scenario = await runScenarioWithCaching({
    canonicalInput: input.canonicalInput,
    activeModifierIds: input.activeModifierIds,
    modifiers: input.modifiers,
    config: input.config,
  });

  return {
    scenario,
    comparison: toScenarioComparison(input.baseline, scenario, input.activeModifierIds),
  };
};

export const buildBaselineComparison = (baseline: ScenarioRunResult): ScenarioComparison => {
  const horizon = horizonRisks(baseline.stage2);

  return {
    active_modifier_ids: [],
    stage2: baseline.stage2,
    unified_index: baseline.unifiedIndex,
    confidence: baseline.confidence,
    risk_delta_by_disease_at_horizon: Object.fromEntries(
      Object.keys(horizon).map((disease) => [disease, 0]),
    ),
    unified_index_delta: 0,
  };
};

export const clearScenarioCache = (): void => {
  scenarioCache.clear();
  inFlightScenarioCache.clear();
};
