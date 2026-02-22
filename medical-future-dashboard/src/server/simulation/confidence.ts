import type {
  CanonicalUserInput,
  ConfidenceOutput,
  Stage1Output,
  Stage2Output,
} from "~/server/simulation/schemas";
import {
  COMPLETENESS_FIELDS,
  COMPLETENESS_FIELD_METADATA,
  DEFAULT_STAGE2_AUC,
  STAGE2_AUC_BY_DISEASE,
} from "~/lib/modelQuality";

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const mean = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
};

const round = (value: number, digits = 1): number => {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
};

const getPathValue = (record: unknown, path: string): unknown => {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, record);
};

export const MODEL_QUALITY_CONFIG = {
  stage1MetricReferenceRanges: {
    maxMeanWasserstein: 8,
    maxMeanRmse: 40,
  },
  stage1MetricWeights: {
    wasserstein: 0.35,
    rmse: 0.35,
    variancePass: 0.3,
  },
  biomarkerConfidenceWeights: {
    metric: 0.45,
    uncertainty: 0.35,
    missingness: 0.2,
  },
  biomarkerConfidenceFloor: 40,
  diseaseReadinessWeights: {
    missingness: 0.7,
    inputUncertainty: 0.3,
  },
  diseaseConfidenceAucFloorMultiplier: 0.68,
  maxAcceptableUncertaintyByBiomarker: {
    bmi: 12,
    systolic_bp: 30,
    diastolic_bp: 18,
    resting_hr: 25,
    ldl: 60,
    hdl: 30,
    total_cholesterol: 90,
    hba1c: 2.2,
    egfr: 40,
    crp: 20,
    sleep_hours: 4,
    alcohol_drinks_per_day: 8,
    pa_minutes_week: 320,
    diet_quality_indicator: 4,
  } as Record<string, number>,
  stage2Aucs: STAGE2_AUC_BY_DISEASE as Record<string, number>,
  defaultStage2Auc: DEFAULT_STAGE2_AUC,
  diseaseRelevantBiomarkers: {
    cardiovascular_disease: ["systolic_bp", "ldl", "hdl", "hba1c", "bmi"],
    chronic_kidney_disease: ["egfr", "systolic_bp", "hba1c"],
    liver_disease: ["bmi", "hba1c", "ldl"],
    cancer_any: ["bmi", "crp", "hba1c"],
    mobility_limitation: ["bmi", "sleep_hours", "pa_minutes_week"],
    cognitive_decline: ["systolic_bp", "hba1c", "sleep_hours"],
    arthritis: ["bmi", "crp", "pa_minutes_week"],
    hearing_loss: ["systolic_bp", "hba1c"],
  } as Record<string, string[]>,
  overallWeights: {
    disease: 0.82,
    biomarker: 0.12,
    missingness: 0.06,
  },
  completenessFields: COMPLETENESS_FIELDS,
} as const;

const missingnessScoreFromCanonical = (canonicalInput: CanonicalUserInput): number => {
  const present = MODEL_QUALITY_CONFIG.completenessFields.filter((path) => {
    const value = getPathValue(canonicalInput, path);
    if (value == null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    return true;
  }).length;

  return clamp(present / MODEL_QUALITY_CONFIG.completenessFields.length, 0, 1);
};

const missingnessRecommendationsFromCanonical = (canonicalInput: CanonicalUserInput) => {
  return MODEL_QUALITY_CONFIG.completenessFields
    .filter((path) => {
      const value = getPathValue(canonicalInput, path);
      if (value == null) return true;
      if (typeof value === "string") return value.trim().length === 0;
      return false;
    })
    .map((path) => {
      const metadata = COMPLETENESS_FIELD_METADATA[path as keyof typeof COMPLETENESS_FIELD_METADATA];
      return {
        field_path: path,
        label: metadata?.label ?? path,
        prompt: metadata?.prompt ?? `Provide ${path}.`,
        relevant_diseases: metadata?.relevant_diseases ? [...metadata.relevant_diseases] : ["all_models"],
      };
    });
};

const biomarkerUncertaintyWidth = (stage1: Stage1Output, biomarker: string): number | null => {
  const lastPoint = stage1.trajectory[stage1.trajectory.length - 1];
  const marker = lastPoint?.biomarkers[biomarker];
  if (!marker) return null;

  if (marker.p05 != null && marker.p95 != null) {
    return Math.max(0, marker.p95 - marker.p05);
  }

  // 90% interval approximation for normal errors.
  return Math.max(0, marker.sigma_total * 3.29);
};

const scoreBiomarkerMetricQuality = (
  meanWasserstein: number | null,
  meanRmse: number | null,
  variancePassRate: number | null,
): number => {
  const wScore =
    meanWasserstein == null
      ? 0.5
      : 1 - clamp(meanWasserstein / MODEL_QUALITY_CONFIG.stage1MetricReferenceRanges.maxMeanWasserstein, 0, 1);

  const rmseScore =
    meanRmse == null
      ? 0.5
      : 1 - clamp(meanRmse / MODEL_QUALITY_CONFIG.stage1MetricReferenceRanges.maxMeanRmse, 0, 1);

  const varianceScore = variancePassRate == null ? 0.5 : clamp(variancePassRate, 0, 1);

  return clamp(
    wScore * MODEL_QUALITY_CONFIG.stage1MetricWeights.wasserstein +
      rmseScore * MODEL_QUALITY_CONFIG.stage1MetricWeights.rmse +
      varianceScore * MODEL_QUALITY_CONFIG.stage1MetricWeights.variancePass,
    0,
    1,
  );
};

const scoreBiomarkerUncertainty = (biomarker: string, uncertaintyWidth: number | null): number => {
  const maxAcceptable = MODEL_QUALITY_CONFIG.maxAcceptableUncertaintyByBiomarker[biomarker] ?? 40;
  if (uncertaintyWidth == null || !Number.isFinite(uncertaintyWidth)) return 0.5;

  return 1 - clamp(uncertaintyWidth / maxAcceptable, 0, 1);
};

const toAucPercent = (auc: number): number => {
  return clamp(auc, 0.5, 0.99) * 100;
};

type ConfidenceArgs = {
  canonicalInput: CanonicalUserInput;
  stage1: Stage1Output;
  stage2: Stage2Output;
};

export const computeConfidenceScores = ({
  canonicalInput,
  stage1,
  stage2,
}: ConfidenceArgs): ConfidenceOutput => {
  const missingness_score = missingnessScoreFromCanonical(canonicalInput);
  const missingness_recommendations = missingnessRecommendationsFromCanonical(canonicalInput);

  const biomarker_confidence: Record<string, number> = {};

  for (const [biomarker, metrics] of Object.entries(stage1.metricScoreByBiomarker)) {
    const metricQuality = scoreBiomarkerMetricQuality(
      metrics.mean_wasserstein,
      metrics.mean_model_rmse,
      metrics.variance_pass_rate,
    );
    const uncertaintyQuality = scoreBiomarkerUncertainty(
      biomarker,
      biomarkerUncertaintyWidth(stage1, biomarker),
    );

    const combined =
      metricQuality * MODEL_QUALITY_CONFIG.biomarkerConfidenceWeights.metric +
      uncertaintyQuality * MODEL_QUALITY_CONFIG.biomarkerConfidenceWeights.uncertainty +
      missingness_score * MODEL_QUALITY_CONFIG.biomarkerConfidenceWeights.missingness;

    const confidence = MODEL_QUALITY_CONFIG.biomarkerConfidenceFloor +
      (100 - MODEL_QUALITY_CONFIG.biomarkerConfidenceFloor) * clamp(combined, 0, 1);

    biomarker_confidence[biomarker] = round(clamp(confidence, 0, 100), 1);
  }

  const disease_confidence: Record<string, number> = {};

  for (const disease of stage2.diseases) {
    const auc = MODEL_QUALITY_CONFIG.stage2Aucs[disease] ?? MODEL_QUALITY_CONFIG.defaultStage2Auc;
    const aucPercent = toAucPercent(auc);

    const relatedBiomarkers =
      MODEL_QUALITY_CONFIG.diseaseRelevantBiomarkers[disease] ?? Object.keys(biomarker_confidence);

    const relatedScores = relatedBiomarkers
      .map((marker) => biomarker_confidence[marker])
      .filter((value): value is number => typeof value === "number")
      .map((value) => value / 100);

    const inputUncertaintyScore = relatedScores.length > 0 ? mean(relatedScores) : 0.5;

    const readiness =
      missingness_score * MODEL_QUALITY_CONFIG.diseaseReadinessWeights.missingness +
      inputUncertaintyScore * MODEL_QUALITY_CONFIG.diseaseReadinessWeights.inputUncertainty;

    const readinessMultiplier =
      MODEL_QUALITY_CONFIG.diseaseConfidenceAucFloorMultiplier +
      (1 - MODEL_QUALITY_CONFIG.diseaseConfidenceAucFloorMultiplier) * clamp(readiness, 0, 1);

    disease_confidence[disease] = round(clamp(aucPercent * readinessMultiplier, 0, 100), 1);
  }

  const overall_confidence = round(
    clamp(
      mean(Object.values(disease_confidence)) * MODEL_QUALITY_CONFIG.overallWeights.disease +
        mean(Object.values(biomarker_confidence)) * MODEL_QUALITY_CONFIG.overallWeights.biomarker +
        missingness_score * 100 * MODEL_QUALITY_CONFIG.overallWeights.missingness,
      0,
      100,
    ),
    1,
  );

  return {
    overall_confidence,
    missingness_score: round(missingness_score, 3),
    missingness_recommendations,
    biomarker_confidence,
    disease_confidence,
  };
};
