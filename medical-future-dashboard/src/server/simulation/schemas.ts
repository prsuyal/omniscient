import { z } from "zod";

export const sexSchema = z.enum(["Male", "Female", "Other", "Unknown"]);

export const raceEthnicitySchema = z.enum([
  "Non-Hispanic White",
  "Non-Hispanic Black",
  "Mexican American",
  "Other Hispanic",
  "Non-Hispanic Asian",
  "Other / Multiracial",
  "Unknown",
]);

export const sourceTypeSchema = z.enum(["structured_form", "freeform_text", "pdf", "derived", "default"]);

export const sourceConfidenceSchema = z.object({
  source: sourceTypeSchema,
  confidence: z.number().min(0).max(1),
  derived_from_freeform: z.boolean().default(false),
});

export const nullableNumber = z.number().finite().nullable();
export const nullableString = z.string().trim().min(1).nullable();

export const nutritionFeaturesSchema = z.object({
  daily_calories_est: nullableNumber,
  protein_g_est: nullableNumber,
  fiber_g_est: nullableNumber,
  added_sugar_g_est: nullableNumber,
  saturated_fat_g_est: nullableNumber,
  sodium_mg_est: nullableNumber,
  fruit_veg_servings_per_day: nullableNumber,
  ultra_processed_freq_per_week: nullableNumber,
  sugary_drinks_per_week: nullableNumber,
  alcohol_drinks_per_day: nullableNumber,
  diet_quality_indicator: z.number().min(0).max(100).nullable(),
  notes: z.string().max(4000).nullable(),
  warnings: z.array(z.string()).default([]),
});

export const canonicalUserInputSchema = z.object({
  demographics: z.object({
    age: nullableNumber,
    sex: z.string().trim().min(1).nullable(),
    race_ethnicity: z.string().trim().min(1).nullable(),
    location: nullableString,
    ses_pir: nullableNumber,
  }),
  body: z.object({
    height_cm: nullableNumber,
    weight_kg: nullableNumber,
    bmi: nullableNumber,
  }),
  vitals: z.object({
    sbp: nullableNumber,
    resting_hr: nullableNumber,
  }),
  labs: z.object({
    ldl: nullableNumber,
    hdl: nullableNumber,
    total_cholesterol: nullableNumber,
    hba1c: nullableNumber,
    egfr: nullableNumber,
  }),
  histories: z.object({
    family_history_text: nullableString,
    personal_history_text: nullableString,
    addiction_history_text: nullableString,
  }),
  medications_text: nullableString,
  behaviors: z.object({
    sleep_hours: nullableNumber,
    alcohol_drinks_per_day: nullableNumber,
    pa_minutes_week: nullableNumber,
    diet_quality_indicator: nullableNumber,
  }),
  nutrition: nutritionFeaturesSchema,
  source_map: z.record(sourceConfidenceSchema),
  nutrition_source_map: z.record(sourceConfidenceSchema).default({}),
});

export const uploadedFileSchema = z.object({
  originalName: z.string().min(1),
  storedName: z.string().min(1),
  storedPath: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export const optionAInputSchema = z.object({
  age: z.number().min(0).max(120).nullable().optional(),
  sex: sexSchema.nullable().optional(),
  raceEthnicity: raceEthnicitySchema.nullable().optional(),
  heightValue: z.number().positive().nullable().optional(),
  heightUnit: z.enum(["cm", "in", "ft"]).default("cm"),
  weightValue: z.number().positive().nullable().optional(),
  weightUnit: z.enum(["kg", "lb"]).default("kg"),
  location: z.string().max(256).nullable().optional(),
  sesPirText: z.string().max(256).nullable().optional(),
  familyHistory: z.string().max(4000).nullable().optional(),
  preExistingConditions: z.string().max(4000).nullable().optional(),
  medications: z.string().max(4000).nullable().optional(),
  nutritionFreeform: z.string().max(8000).nullable().optional(),
  sbp: z.number().min(40).max(300).nullable().optional(),
  restingHr: z.number().min(20).max(260).nullable().optional(),
  ldl: z.number().min(0).max(400).nullable().optional(),
  hdl: z.number().min(0).max(200).nullable().optional(),
  totalCholesterol: z.number().min(0).max(600).nullable().optional(),
  hba1c: z.number().min(2).max(25).nullable().optional(),
  egfr: z.number().min(0).max(200).nullable().optional(),
  sleepHours: z.number().min(0).max(24).nullable().optional(),
  alcoholDrinksPerDay: z.number().min(0).max(40).nullable().optional(),
  paMinutesWeek: z.number().min(0).max(20_000).nullable().optional(),
  dietQualityIndicator: z.number().min(-5).max(100).nullable().optional(),
});

export const optionBInputSchema = z.object({
  freeformText: z.string().max(50_000).nullable().optional(),
  nutritionFreeform: z.string().max(8000).nullable().optional(),
  files: z.array(uploadedFileSchema).default([]),
});

export const simulationCreateInputSchema = z.union([
  z.object({
    mode: z.literal("optionA"),
    payload: optionAInputSchema,
    startAge: z.number().min(0).max(120).nullable().optional(),
    endAge: z.number().min(0).max(130).nullable().optional(),
    monteCarloSamples: z.number().int().min(20).max(2000).default(120),
  }),
  z.object({
    mode: z.literal("optionB"),
    payload: optionBInputSchema,
    startAge: z.number().min(0).max(120).nullable().optional(),
    endAge: z.number().min(0).max(130).nullable().optional(),
    monteCarloSamples: z.number().int().min(20).max(2000).default(120),
  }),
]);

export const biomarkerYearPointSchema = z.object({
  age: z.number(),
  biomarkers: z.record(
    z.object({
      mean: z.number(),
      p05: z.number().nullable(),
      p50: z.number().nullable(),
      p95: z.number().nullable(),
      base_sigma: z.number(),
      sigma_total: z.number(),
    }),
  ),
});

export const stage1OutputSchema = z.object({
  startAge: z.number(),
  endAge: z.number(),
  trajectory: z.array(biomarkerYearPointSchema),
  metricScoreByBiomarker: z.record(
    z.object({
      mean_wasserstein: z.number().nullable(),
      mean_model_rmse: z.number().nullable(),
      variance_pass_rate: z.number().nullable(),
      error_score: z.number(),
      sigma_model: z.number(),
    }),
  ),
});

export const stage2YearRiskSchema = z.object({
  age: z.number(),
  deterministic: z.record(z.number()),
  uncertainty: z.record(
    z.object({
      mean: z.number(),
      median: z.number(),
      p05: z.number(),
      p95: z.number(),
    }),
  ),
});

export const stage2OutputSchema = z.object({
  diseases: z.array(z.string()),
  years: z.array(stage2YearRiskSchema),
});

export const unifiedIndexOutputSchema = z.object({
  value: z.number().min(0).max(100),
  behavior_score: z.number().min(0).max(1),
  biomarker_score: z.number().min(0).max(1),
  predicted_risk_score: z.number().min(0).max(1),
  preventable_fraction_by_disease: z.record(z.number().min(0).max(1)),
  top3_preventable_risks: z.array(
    z.object({
      disease: z.string(),
      preventable_fraction: z.number().min(0).max(1),
      baseline_risk: z.number().min(0).max(1),
      best_risk: z.number().min(0).max(1),
    }),
  ),
});

export const confidenceOutputSchema = z.object({
  overall_confidence: z.number().min(0).max(100),
  missingness_score: z.number().min(0).max(1),
  missingness_recommendations: z.array(
    z.object({
      field_path: z.string(),
      label: z.string(),
      prompt: z.string(),
      relevant_diseases: z.array(z.string()),
    }),
  ).default([]),
  biomarker_confidence: z.record(z.number().min(0).max(100)),
  disease_confidence: z.record(z.number().min(0).max(100)),
});

export const modifierCategorySchema = z.enum([
  "breaking_negative_habits",
  "positive_habits_non_medical",
  "medication_prescribed",
  "surgical_treatments",
]);

export const modifierDefinitionSchema = z.object({
  id: z.string(),
  category: modifierCategorySchema,
  title: z.string(),
  description: z.string(),
  enabledByDefault: z.boolean().default(false),
  deltas: z.record(z.number()),
});

export const modifierImpactSchema = z.object({
  modifier_id: z.string(),
  category: modifierCategorySchema,
  title: z.string(),
  stage2: stage2OutputSchema,
  unified_index: unifiedIndexOutputSchema,
  confidence: confidenceOutputSchema,
  risk_delta_by_disease_at_horizon: z.record(z.number()),
  unified_index_delta: z.number(),
});

export const scenarioComparisonSchema = z.object({
  active_modifier_ids: z.array(z.string()),
  stage2: stage2OutputSchema,
  unified_index: unifiedIndexOutputSchema,
  confidence: confidenceOutputSchema,
  risk_delta_by_disease_at_horizon: z.record(z.number()),
  unified_index_delta: z.number(),
});

export const pipelineWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const pipelineErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const pipelineResultSchema = z.object({
  canonicalInput: canonicalUserInputSchema,
  stage1: stage1OutputSchema,
  stage2: stage2OutputSchema,
  unifiedIndex: unifiedIndexOutputSchema,
  confidence: confidenceOutputSchema,
  modifiers: z.array(modifierDefinitionSchema),
  modifierImpacts: z.array(modifierImpactSchema),
  baseScenarioComparison: scenarioComparisonSchema,
  scenarioComparisons: z.record(scenarioComparisonSchema).default({}),
  warnings: z.array(pipelineWarningSchema),
  errors: z.array(pipelineErrorSchema),
});

export type CanonicalUserInput = z.infer<typeof canonicalUserInputSchema>;
export type NutritionFeatures = z.infer<typeof nutritionFeaturesSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type OptionAInput = z.infer<typeof optionAInputSchema>;
export type OptionBInput = z.infer<typeof optionBInputSchema>;
export type SimulationCreateInput = z.infer<typeof simulationCreateInputSchema>;
export type Stage1Output = z.infer<typeof stage1OutputSchema>;
export type Stage2Output = z.infer<typeof stage2OutputSchema>;
export type UnifiedIndexOutput = z.infer<typeof unifiedIndexOutputSchema>;
export type ConfidenceOutput = z.infer<typeof confidenceOutputSchema>;
export type ModifierCategory = z.infer<typeof modifierCategorySchema>;
export type ModifierDefinition = z.infer<typeof modifierDefinitionSchema>;
export type ModifierImpact = z.infer<typeof modifierImpactSchema>;
export type ScenarioComparison = z.infer<typeof scenarioComparisonSchema>;
export type PipelineResult = z.infer<typeof pipelineResultSchema>;
export type UploadedFileMeta = z.infer<typeof uploadedFileSchema>;
