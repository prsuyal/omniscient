import path from "node:path";

import {
  fallbackOptionBFromTextOnly,
  parseOptionBWithOpenAI,
  parseStructuredOptionA,
} from "~/server/simulation/openaiParser";
import { generateCandidateModifiers } from "~/server/simulation/modifiers";
import { parseNutritionFreeform, nutritionToModelDietQuality } from "~/server/simulation/nutritionParser";
import { extractPdfText } from "~/server/simulation/pdfExtract";
import {
  buildBaselineComparison,
  runScenarioWithCaching,
} from "~/server/simulation/scenarioRunner";
import {
  type CanonicalUserInput,
  nutritionFeaturesSchema,
  type OptionAInput,
  type OptionBInput,
  pipelineResultSchema,
  type PipelineResult,
} from "~/server/simulation/schemas";

export class SimulationPipelineError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type PipelineInput =
  | {
      mode: "optionA";
      payload: OptionAInput;
      startAge?: number | null;
      endAge?: number | null;
      monteCarloSamples?: number;
    }
  | {
      mode: "optionB";
      payload: OptionBInput;
      startAge?: number | null;
      endAge?: number | null;
      monteCarloSamples?: number;
    };

const resolvePath = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(process.cwd(), value));

const nutritionWarningsToPipelineWarnings = (
  warnings: string[],
): Array<{ code: string; message: string; details?: unknown }> => {
  return warnings.map((warning) => ({
    code: "NUTRITION_PARSE_WARNING",
    message: warning,
  }));
};

const asNonEmptyString = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getAtPath = (record: unknown, pathKey: string): unknown => {
  return pathKey.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, record);
};

const mergeCanonicalWithPatch = (
  baseline: CanonicalUserInput,
  patch: CanonicalUserInput,
): CanonicalUserInput => {
  const merged: CanonicalUserInput = {
    demographics: {
      age: patch.demographics.age ?? baseline.demographics.age,
      sex: patch.demographics.sex ?? baseline.demographics.sex,
      race_ethnicity: patch.demographics.race_ethnicity ?? baseline.demographics.race_ethnicity,
      location: patch.demographics.location ?? baseline.demographics.location,
      ses_pir: patch.demographics.ses_pir ?? baseline.demographics.ses_pir,
    },
    body: {
      height_cm: patch.body.height_cm ?? baseline.body.height_cm,
      weight_kg: patch.body.weight_kg ?? baseline.body.weight_kg,
      bmi: patch.body.bmi ?? baseline.body.bmi,
    },
    vitals: {
      sbp: patch.vitals.sbp ?? baseline.vitals.sbp,
      resting_hr: patch.vitals.resting_hr ?? baseline.vitals.resting_hr,
    },
    labs: {
      ldl: patch.labs.ldl ?? baseline.labs.ldl,
      hdl: patch.labs.hdl ?? baseline.labs.hdl,
      total_cholesterol: patch.labs.total_cholesterol ?? baseline.labs.total_cholesterol,
      hba1c: patch.labs.hba1c ?? baseline.labs.hba1c,
      egfr: patch.labs.egfr ?? baseline.labs.egfr,
    },
    histories: {
      family_history_text: patch.histories.family_history_text ?? baseline.histories.family_history_text,
      personal_history_text: patch.histories.personal_history_text ?? baseline.histories.personal_history_text,
      addiction_history_text: patch.histories.addiction_history_text ?? baseline.histories.addiction_history_text,
    },
    medications_text: patch.medications_text ?? baseline.medications_text,
    behaviors: {
      sleep_hours: patch.behaviors.sleep_hours ?? baseline.behaviors.sleep_hours,
      alcohol_drinks_per_day:
        patch.behaviors.alcohol_drinks_per_day ?? baseline.behaviors.alcohol_drinks_per_day,
      pa_minutes_week: patch.behaviors.pa_minutes_week ?? baseline.behaviors.pa_minutes_week,
      diet_quality_indicator: patch.behaviors.diet_quality_indicator ?? baseline.behaviors.diet_quality_indicator,
    },
    nutrition: {
      ...baseline.nutrition,
      warnings: [...(baseline.nutrition.warnings ?? [])],
    },
    source_map: {
      ...baseline.source_map,
    },
    nutrition_source_map: {
      ...baseline.nutrition_source_map,
    },
  };

  const nutritionKeys = Object.keys(nutritionFeaturesSchema.shape) as Array<keyof CanonicalUserInput["nutrition"]>;
  for (const key of nutritionKeys) {
    if (key === "warnings") continue;
    const patchValue = patch.nutrition[key];
    if (patchValue != null) {
      (merged.nutrition as Record<string, unknown>)[key] = patchValue;
    }
  }

  merged.nutrition.warnings = [
    ...(baseline.nutrition.warnings ?? []),
    ...(patch.nutrition.warnings ?? []),
  ];

  for (const [pathKey, source] of Object.entries(patch.source_map)) {
    const patchedValue = getAtPath(patch, pathKey);
    if (patchedValue == null) continue;
    if (typeof patchedValue === "string" && patchedValue.trim().length === 0) continue;
    merged.source_map[pathKey] = source;
  }

  for (const [field, source] of Object.entries(patch.nutrition_source_map)) {
    const patchedValue = patch.nutrition[field as keyof CanonicalUserInput["nutrition"]];
    if (patchedValue == null) continue;
    if (typeof patchedValue === "string" && patchedValue.trim().length === 0) continue;
    merged.nutrition_source_map[field] = source;
  }

  return merged;
};

const mergeNutritionIntoCanonical = async (
  canonical: CanonicalUserInput,
  nutritionFreeform: string | null | undefined,
) => {
  const nutritionResult = await parseNutritionFreeform(nutritionFreeform);
  const mergedNutrition = { ...canonical.nutrition };
  const nutritionKeys = Object.keys(nutritionFeaturesSchema.shape) as Array<keyof typeof mergedNutrition>;

  for (const key of nutritionKeys) {
    if (key === "warnings") continue;
    const parsedValue = nutritionResult.nutrition[key];
    if (parsedValue != null) {
      (mergedNutrition as Record<string, unknown>)[key] = parsedValue;
    }
  }

  const next: CanonicalUserInput = {
    ...canonical,
    nutrition: {
      ...mergedNutrition,
      notes: nutritionResult.nutrition.notes ?? canonical.nutrition.notes,
      warnings: [...(canonical.nutrition.warnings ?? []), ...(nutritionResult.nutrition.warnings ?? [])],
    },
    nutrition_source_map: {
      ...canonical.nutrition_source_map,
      ...nutritionResult.nutrition_source_map,
    },
  };

  // Nutrition and behavior features share diet/alcohol semantics; map nutrition into model inputs when missing.
  if (next.behaviors.alcohol_drinks_per_day == null && next.nutrition.alcohol_drinks_per_day != null) {
    next.behaviors.alcohol_drinks_per_day = next.nutrition.alcohol_drinks_per_day;
    next.source_map["behaviors.alcohol_drinks_per_day"] = {
      source: "derived",
      confidence: next.nutrition_source_map.alcohol_drinks_per_day?.confidence ?? 0.55,
      derived_from_freeform: true,
    };
  }

  if (next.behaviors.diet_quality_indicator == null) {
    const modelScaleDiet = nutritionToModelDietQuality(next.nutrition.diet_quality_indicator);
    if (modelScaleDiet != null) {
      next.behaviors.diet_quality_indicator = modelScaleDiet;
      next.source_map["behaviors.diet_quality_indicator"] = {
        source: "derived",
        confidence: next.nutrition_source_map.diet_quality_indicator?.confidence ?? 0.55,
        derived_from_freeform: true,
      };
    }
  }

  return next;
};

const parseCanonicalInput = async (
  input: PipelineInput,
  warnings: Array<{ code: string; message: string; details?: unknown }>,
): Promise<CanonicalUserInput> => {
  if (input.mode === "optionA") {
    const canonical = parseStructuredOptionA(input.payload);
    const withNutrition = await mergeNutritionIntoCanonical(canonical, input.payload.nutritionFreeform ?? null);
    warnings.push(...nutritionWarningsToPipelineWarnings(withNutrition.nutrition.warnings));
    return withNutrition;
  }

  const freeform = input.payload.freeformText?.trim() ?? "";
  const pdfTexts: string[] = [];

  for (const file of input.payload.files) {
    try {
      const text = await extractPdfText(resolvePath(file.storedPath));
      if (text.trim()) pdfTexts.push(text.trim());
    } catch (error) {
      warnings.push({
        code: "PDF_EXTRACT_FAILED",
        message: `Failed to extract ${file.originalName}; continuing with available text only.`,
        details: {
          file: file.originalName,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  const mergedPdfText = pdfTexts.join("\n\n---\n\n");

  let canonical: CanonicalUserInput;

  try {
    canonical = await parseOptionBWithOpenAI({
      freeformText: freeform,
      pdfText: mergedPdfText,
    });
  } catch (error) {
    warnings.push({
      code: "OPENAI_PARSE_FALLBACK",
      message: "OpenAI parse failed; using conservative fallback parser.",
      details: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });

    canonical = fallbackOptionBFromTextOnly(freeform, mergedPdfText);
  }

  const nutritionText = input.payload.nutritionFreeform?.trim() ?? freeform;
  const withNutrition = await mergeNutritionIntoCanonical(canonical, nutritionText);
  warnings.push(...nutritionWarningsToPipelineWarnings(withNutrition.nutrition.warnings));

  return withNutrition;
};

export const applyFreeformUpdateToCanonical = async (
  baselineCanonical: CanonicalUserInput,
  freeformText: string,
  nutritionFreeform?: string | null,
): Promise<{
  canonicalInput: CanonicalUserInput;
  warnings: Array<{ code: string; message: string; details?: unknown }>;
}> => {
  const warnings: Array<{ code: string; message: string; details?: unknown }> = [];
  const normalizedText = asNonEmptyString(freeformText);
  const normalizedNutrition = asNonEmptyString(nutritionFreeform ?? null);

  if (!normalizedText && !normalizedNutrition) {
    return { canonicalInput: baselineCanonical, warnings };
  }

  let patchCanonical = baselineCanonical;
  if (normalizedText) {
    try {
      patchCanonical = await parseOptionBWithOpenAI({
        freeformText: normalizedText,
        pdfText: "",
      });
    } catch (error) {
      warnings.push({
        code: "OPENAI_UPDATE_PARSE_FALLBACK",
        message: "Update parser used fallback extraction for freeform update text.",
        details: {
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      patchCanonical = fallbackOptionBFromTextOnly(normalizedText, "");
    }
  }

  const merged = mergeCanonicalWithPatch(baselineCanonical, patchCanonical);
  const nutritionText = normalizedNutrition ?? normalizedText;
  const withNutrition = await mergeNutritionIntoCanonical(merged, nutritionText);
  warnings.push(...nutritionWarningsToPipelineWarnings(withNutrition.nutrition.warnings));

  return {
    canonicalInput: withNutrition,
    warnings,
  };
};

export const runSimulationPipeline = async (input: PipelineInput): Promise<PipelineResult> => {
  const warnings: Array<{ code: string; message: string; details?: unknown }> = [];
  const errors: Array<{ code: string; message: string; details?: unknown }> = [];

  let canonicalInput: CanonicalUserInput;

  try {
    canonicalInput = await parseCanonicalInput(input, warnings);
  } catch (error) {
    throw new SimulationPipelineError("CANONICAL_PARSE_FAILED", "Failed to parse canonical input.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const canonicalAge = canonicalInput.demographics.age ?? 45;
  const effectiveStartAge = Math.max(20, Math.min(90, Math.round(input.startAge ?? canonicalAge)));
  const requestedEndAge = input.endAge ?? Math.min(95, effectiveStartAge + 40);
  const effectiveEndAge = requestedEndAge <= effectiveStartAge ? effectiveStartAge + 20 : requestedEndAge;

  const monteCarloSamples = input.monteCarloSamples ?? 120;

  const scenarioConfig = {
    startAge: effectiveStartAge,
    endAge: effectiveEndAge,
    monteCarloSamples,
  };

  const modifiers = await generateCandidateModifiers(canonicalInput);

  let baselineScenario: Awaited<ReturnType<typeof runScenarioWithCaching>>;

  try {
    baselineScenario = await runScenarioWithCaching({
      canonicalInput,
      activeModifierIds: [],
      modifiers,
      config: scenarioConfig,
    });
  } catch (error) {
    throw new SimulationPipelineError("BASELINE_SCENARIO_FAILED", "Failed to run baseline scenario.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const baseScenarioComparison = buildBaselineComparison(baselineScenario);

  const scenarioComparisons: Record<string, typeof baseScenarioComparison> = {
    baseline: baseScenarioComparison,
  };

  return pipelineResultSchema.parse({
    canonicalInput: baselineScenario.canonicalInput,
    stage1: baselineScenario.stage1,
    stage2: baselineScenario.stage2,
    unifiedIndex: baselineScenario.unifiedIndex,
    confidence: baselineScenario.confidence,
    modifiers,
    modifierImpacts: [],
    baseScenarioComparison,
    scenarioComparisons,
    warnings,
    errors,
  });
};
