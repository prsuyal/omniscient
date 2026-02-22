import type {
  CanonicalUserInput,
  Stage1Output,
  Stage2Output,
  UnifiedIndexOutput,
} from "~/server/simulation/schemas";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const mean = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
};

const normalizeLinear = (value: number | null | undefined, best: number, worst: number): number => {
  if (value == null || !Number.isFinite(value)) return 0.5;
  if (best === worst) return 0.5;

  const low = Math.min(best, worst);
  const high = Math.max(best, worst);
  const clamped = clamp(value, low, high);

  if (best > worst) {
    return (clamped - worst) / (best - worst);
  }

  return (worst - clamped) / (worst - best);
};

const sleepQualityScore = (hours: number | null | undefined): number => {
  if (hours == null || !Number.isFinite(hours)) return 0.5;

  // Sleep has a U-shaped risk curve; 7-8h is optimal, far below/above is worse.
  const distanceFromOptimal = Math.abs(hours - 7.5);
  return clamp(1 - distanceFromOptimal / 4.5, 0, 1);
};

const latestBiomarkerValue = (stage1: Stage1Output, biomarker: string): number | null => {
  const lastPoint = stage1.trajectory[stage1.trajectory.length - 1];
  if (!lastPoint) return null;
  return lastPoint.biomarkers[biomarker]?.mean ?? null;
};

const riskAtHorizonByDisease = (stage2: Stage2Output): Record<string, number> => {
  const lastYear = stage2.years[stage2.years.length - 1];
  if (!lastYear) return {};
  return { ...lastYear.deterministic };
};

export const UNIFIED_INDEX_CONFIG = {
  componentWeights: {
    behaviors: 0.35,
    biomarkers: 0.35,
    predictedRisk: 0.3,
  },
  behaviorWeights: {
    exercise: 0.3,
    sleep: 0.25,
    alcohol: 0.2,
    diet: 0.25,
  },
  biomarkerWeights: {
    systolic_bp: 0.2,
    hba1c: 0.2,
    ldl: 0.18,
    hdl: 0.12,
    bmi: 0.15,
    egfr: 0.15,
  },
  anchors: {
    // Anchors define conceptual full-range normalization. "Best" approximates ideal prevention-focused state,
    // while "Worst" approximates severe but plausible chronic-risk profile. This ensures 0-100 is meaningful.
    exercise_minutes_week: { best: 300, worst: 0 },
    alcohol_drinks_day: { best: 0, worst: 6 },
    diet_quality_indicator_100: { best: 90, worst: 20 },
    systolic_bp: { best: 110, worst: 180 },
    hba1c: { best: 5.0, worst: 10.0 },
    ldl: { best: 70, worst: 220 },
    hdl: { best: 65, worst: 25 },
    bmi: { best: 22, worst: 45 },
    egfr: { best: 100, worst: 20 },
    // Predicted risk aggregate is mean disease probability over the forecast horizon.
    predicted_risk_mean: { best: 0.05, worst: 0.75 },
  },
} as const;

type ComputeUnifiedHealthIndexArgs = {
  canonicalInput: CanonicalUserInput;
  stage1: Stage1Output;
  stage2: Stage2Output;
  bestAchievableStage2?: Stage2Output | null;
};

export const computeUnifiedHealthIndex = ({
  canonicalInput,
  stage1,
  stage2,
  bestAchievableStage2,
}: ComputeUnifiedHealthIndexArgs): UnifiedIndexOutput => {
  const behaviorSubScores = {
    exercise: normalizeLinear(
      canonicalInput.behaviors.pa_minutes_week,
      UNIFIED_INDEX_CONFIG.anchors.exercise_minutes_week.best,
      UNIFIED_INDEX_CONFIG.anchors.exercise_minutes_week.worst,
    ),
    sleep: sleepQualityScore(canonicalInput.behaviors.sleep_hours),
    alcohol: normalizeLinear(
      canonicalInput.behaviors.alcohol_drinks_per_day,
      UNIFIED_INDEX_CONFIG.anchors.alcohol_drinks_day.best,
      UNIFIED_INDEX_CONFIG.anchors.alcohol_drinks_day.worst,
    ),
    diet: normalizeLinear(
      canonicalInput.nutrition.diet_quality_indicator,
      UNIFIED_INDEX_CONFIG.anchors.diet_quality_indicator_100.best,
      UNIFIED_INDEX_CONFIG.anchors.diet_quality_indicator_100.worst,
    ),
  };

  const behavior_score = clamp(
    behaviorSubScores.exercise * UNIFIED_INDEX_CONFIG.behaviorWeights.exercise +
      behaviorSubScores.sleep * UNIFIED_INDEX_CONFIG.behaviorWeights.sleep +
      behaviorSubScores.alcohol * UNIFIED_INDEX_CONFIG.behaviorWeights.alcohol +
      behaviorSubScores.diet * UNIFIED_INDEX_CONFIG.behaviorWeights.diet,
    0,
    1,
  );

  const biomarkerSubScores = {
    systolic_bp: normalizeLinear(
      latestBiomarkerValue(stage1, "systolic_bp"),
      UNIFIED_INDEX_CONFIG.anchors.systolic_bp.best,
      UNIFIED_INDEX_CONFIG.anchors.systolic_bp.worst,
    ),
    hba1c: normalizeLinear(
      latestBiomarkerValue(stage1, "hba1c"),
      UNIFIED_INDEX_CONFIG.anchors.hba1c.best,
      UNIFIED_INDEX_CONFIG.anchors.hba1c.worst,
    ),
    ldl: normalizeLinear(
      latestBiomarkerValue(stage1, "ldl"),
      UNIFIED_INDEX_CONFIG.anchors.ldl.best,
      UNIFIED_INDEX_CONFIG.anchors.ldl.worst,
    ),
    hdl: normalizeLinear(
      latestBiomarkerValue(stage1, "hdl"),
      UNIFIED_INDEX_CONFIG.anchors.hdl.best,
      UNIFIED_INDEX_CONFIG.anchors.hdl.worst,
    ),
    bmi: normalizeLinear(
      latestBiomarkerValue(stage1, "bmi"),
      UNIFIED_INDEX_CONFIG.anchors.bmi.best,
      UNIFIED_INDEX_CONFIG.anchors.bmi.worst,
    ),
    egfr: normalizeLinear(
      latestBiomarkerValue(stage1, "egfr"),
      UNIFIED_INDEX_CONFIG.anchors.egfr.best,
      UNIFIED_INDEX_CONFIG.anchors.egfr.worst,
    ),
  };

  const biomarker_score = clamp(
    biomarkerSubScores.systolic_bp * UNIFIED_INDEX_CONFIG.biomarkerWeights.systolic_bp +
      biomarkerSubScores.hba1c * UNIFIED_INDEX_CONFIG.biomarkerWeights.hba1c +
      biomarkerSubScores.ldl * UNIFIED_INDEX_CONFIG.biomarkerWeights.ldl +
      biomarkerSubScores.hdl * UNIFIED_INDEX_CONFIG.biomarkerWeights.hdl +
      biomarkerSubScores.bmi * UNIFIED_INDEX_CONFIG.biomarkerWeights.bmi +
      biomarkerSubScores.egfr * UNIFIED_INDEX_CONFIG.biomarkerWeights.egfr,
    0,
    1,
  );

  const allPredictedRisks = stage2.years.flatMap((year) => Object.values(year.deterministic));
  const riskMean = mean(allPredictedRisks);

  const predicted_risk_score = normalizeLinear(
    riskMean,
    UNIFIED_INDEX_CONFIG.anchors.predicted_risk_mean.best,
    UNIFIED_INDEX_CONFIG.anchors.predicted_risk_mean.worst,
  );

  const composite01 =
    behavior_score * UNIFIED_INDEX_CONFIG.componentWeights.behaviors +
    biomarker_score * UNIFIED_INDEX_CONFIG.componentWeights.biomarkers +
    predicted_risk_score * UNIFIED_INDEX_CONFIG.componentWeights.predictedRisk;

  const value = clamp(Math.round(composite01 * 1000) / 10, 0, 100);

  const baselineByDisease = riskAtHorizonByDisease(stage2);
  const bestByDisease = riskAtHorizonByDisease(bestAchievableStage2 ?? stage2);

  const preventable_fraction_by_disease: Record<string, number> = {};

  for (const disease of Object.keys(baselineByDisease)) {
    const baseline = baselineByDisease[disease] ?? 0;
    const best = bestByDisease[disease] ?? baseline;
    const fraction = baseline <= 0 ? 0 : clamp((baseline - best) / baseline, 0, 1);
    preventable_fraction_by_disease[disease] = Math.round(fraction * 1000) / 1000;
  }

  const top3_preventable_risks = Object.entries(preventable_fraction_by_disease)
    .map(([disease, preventable_fraction]) => {
      const baseline_risk = baselineByDisease[disease] ?? 0;
      const best_risk = bestByDisease[disease] ?? baseline_risk;

      return {
        disease,
        preventable_fraction,
        baseline_risk: clamp(Math.round(baseline_risk * 1000) / 1000, 0, 1),
        best_risk: clamp(Math.round(best_risk * 1000) / 1000, 0, 1),
      };
    })
    .sort((a, b) => b.preventable_fraction - a.preventable_fraction)
    .slice(0, 3);

  return {
    value,
    behavior_score: clamp(Math.round(behavior_score * 1000) / 1000, 0, 1),
    biomarker_score: clamp(Math.round(biomarker_score * 1000) / 1000, 0, 1),
    predicted_risk_score: clamp(Math.round(predicted_risk_score * 1000) / 1000, 0, 1),
    preventable_fraction_by_disease,
    top3_preventable_risks,
  };
};
