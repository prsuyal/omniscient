import OpenAI from "openai";

import { env } from "~/env";
import {
  nutritionFeaturesSchema,
  type NutritionFeatures,
  type SourceType,
  sourceTypeSchema,
} from "~/server/simulation/schemas";

const NUTRITION_NUMERIC_FIELDS = [
  "daily_calories_est",
  "protein_g_est",
  "fiber_g_est",
  "added_sugar_g_est",
  "saturated_fat_g_est",
  "sodium_mg_est",
  "fruit_veg_servings_per_day",
  "ultra_processed_freq_per_week",
  "sugary_drinks_per_week",
  "alcohol_drinks_per_day",
  "diet_quality_indicator",
] as const;

type NutritionNumericField = (typeof NUTRITION_NUMERIC_FIELDS)[number];

export type NutritionSourceMap = Record<
  string,
  {
    source: SourceType;
    confidence: number;
    derived_from_freeform: boolean;
  }
>;

export type NutritionParseResult = {
  nutrition: NutritionFeatures;
  nutrition_source_map: NutritionSourceMap;
};

type OpenAINutritionResult = {
  features: Record<string, number | string | null>;
  confidence_by_field: Record<string, number>;
  warnings: string[];
};

const DEFAULT_NOTES = "No nutrition details provided.";

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const toNullableNumber = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const round = (value: number, digits = 2): number => {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
};

const emptyNutrition = (): NutritionFeatures =>
  nutritionFeaturesSchema.parse({
    daily_calories_est: null,
    protein_g_est: null,
    fiber_g_est: null,
    added_sugar_g_est: null,
    saturated_fat_g_est: null,
    sodium_mg_est: null,
    fruit_veg_servings_per_day: null,
    ultra_processed_freq_per_week: null,
    sugary_drinks_per_week: null,
    alcohol_drinks_per_day: null,
    diet_quality_indicator: null,
    notes: DEFAULT_NOTES,
    warnings: [],
  });

const emptyNutritionSourceMap = (
  source: SourceType = "default",
  confidence = 0,
  derivedFromFreeform = false,
): NutritionSourceMap => {
  return Object.fromEntries(
    NUTRITION_NUMERIC_FIELDS.map((field) => [
      field,
      {
        source,
        confidence,
        derived_from_freeform: derivedFromFreeform,
      },
    ]),
  );
};

const OPENAI_NUMERIC_FIELD_SCHEMA = {
  type: ["number", "null"],
} as const;

const OPENAI_NUTRITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["features", "confidence_by_field", "warnings"],
  properties: {
    features: {
      type: "object",
      additionalProperties: false,
      required: [...NUTRITION_NUMERIC_FIELDS, "notes"],
      properties: {
        daily_calories_est: OPENAI_NUMERIC_FIELD_SCHEMA,
        protein_g_est: OPENAI_NUMERIC_FIELD_SCHEMA,
        fiber_g_est: OPENAI_NUMERIC_FIELD_SCHEMA,
        added_sugar_g_est: OPENAI_NUMERIC_FIELD_SCHEMA,
        saturated_fat_g_est: OPENAI_NUMERIC_FIELD_SCHEMA,
        sodium_mg_est: OPENAI_NUMERIC_FIELD_SCHEMA,
        fruit_veg_servings_per_day: OPENAI_NUMERIC_FIELD_SCHEMA,
        ultra_processed_freq_per_week: OPENAI_NUMERIC_FIELD_SCHEMA,
        sugary_drinks_per_week: OPENAI_NUMERIC_FIELD_SCHEMA,
        alcohol_drinks_per_day: OPENAI_NUMERIC_FIELD_SCHEMA,
        diet_quality_indicator: OPENAI_NUMERIC_FIELD_SCHEMA,
        notes: {
          type: ["string", "null"],
        },
      },
    },
    confidence_by_field: {
      type: "object",
      additionalProperties: false,
      required: NUTRITION_NUMERIC_FIELDS,
      properties: Object.fromEntries(
        NUTRITION_NUMERIC_FIELDS.map((field) => [
          field,
          {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
        ]),
      ),
    },
    warnings: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
} as const;

const openAIClient = () => {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
};

const extractOpenAIOutputText = (response: unknown): string => {
  const direct = (response as { output_text?: string })?.output_text;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct;
  }

  const outputs = (response as { output?: Array<{ content?: Array<{ text?: string }> }> })?.output;
  if (!outputs?.length) {
    throw new Error("OpenAI nutrition response had no output.");
  }

  const merged = outputs
    .flatMap((entry) => entry.content ?? [])
    .map((chunk) => chunk.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();

  if (!merged) {
    throw new Error("OpenAI nutrition output was empty.");
  }

  return merged;
};

const sanitizeFieldNumber = (field: NutritionNumericField, value: number | null): number | null => {
  if (value == null) return null;

  switch (field) {
    case "diet_quality_indicator":
      return clamp(round(value, 1), 0, 100);
    case "daily_calories_est":
      return clamp(round(value), 600, 7000);
    case "protein_g_est":
      return clamp(round(value, 1), 0, 500);
    case "fiber_g_est":
      return clamp(round(value, 1), 0, 120);
    case "added_sugar_g_est":
      return clamp(round(value, 1), 0, 350);
    case "saturated_fat_g_est":
      return clamp(round(value, 1), 0, 200);
    case "sodium_mg_est":
      return clamp(round(value), 0, 10000);
    case "fruit_veg_servings_per_day":
      return clamp(round(value, 1), 0, 20);
    case "ultra_processed_freq_per_week":
      return clamp(round(value, 1), 0, 50);
    case "sugary_drinks_per_week":
      return clamp(round(value, 1), 0, 70);
    case "alcohol_drinks_per_day":
      return clamp(round(value, 2), 0, 25);
    default:
      return value;
  }
};

const nutritionFromOpenAIOutput = (parsed: OpenAINutritionResult): NutritionParseResult => {
  const base = emptyNutrition();

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((warning) => typeof warning === "string" && warning.trim().length > 0)
    : [];

  const features = {
    ...base,
    ...Object.fromEntries(
      NUTRITION_NUMERIC_FIELDS.map((field) => [
        field,
        sanitizeFieldNumber(field, toNullableNumber(parsed.features[field])),
      ]),
    ),
    notes:
      typeof parsed.features.notes === "string" && parsed.features.notes.trim().length > 0
        ? parsed.features.notes.trim()
        : base.notes,
    warnings,
  } satisfies NutritionFeatures;

  const nutrition = nutritionFeaturesSchema.parse(features);

  const nutrition_source_map: NutritionSourceMap = emptyNutritionSourceMap("freeform_text", 0.15, true);

  for (const field of NUTRITION_NUMERIC_FIELDS) {
    const confidenceRaw = toNullableNumber(parsed.confidence_by_field[field]);
    nutrition_source_map[field] = {
      source: sourceTypeSchema.parse("freeform_text"),
      confidence: clamp(confidenceRaw ?? 0.15, 0, 1),
      derived_from_freeform: true,
    };
  }

  return {
    nutrition,
    nutrition_source_map,
  };
};

const parseNumericAfterToken = (text: string, tokenPattern: RegExp): number | null => {
  const match = tokenPattern.exec(text);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseServings = (text: string): number | null => {
  const explicit = parseNumericAfterToken(
    text,
    /(?:fruit|veggies|vegetables|servings?)\D{0,16}(\d+(?:\.\d+)?)(?:\s*(?:per|\/)\s*day)?/i,
  );
  if (explicit != null) return explicit;

  if (/low\s+veggies|few\s+vegetables|rarely\s+vegetables/i.test(text)) return 1;
  if (/mediterranean|plant[- ]based|lots of vegetables|high vegetable|high fiber/i.test(text)) return 5;
  return null;
};

const parseWeeklyFrequency = (text: string, token: RegExp): number | null => {
  const direct = parseNumericAfterToken(text, token);
  if (direct != null) return direct;

  if (/daily/i.test(text)) return 7;
  if (/most days/i.test(text)) return 5;
  if (/occasionally|sometimes/i.test(text)) return 2;
  return null;
};

const estimateDietQuality = (text: string, existing: Partial<NutritionFeatures>): number | null => {
  if (existing.diet_quality_indicator != null) return existing.diet_quality_indicator;

  let score = 55;
  let hasSignal = false;

  if (/mediterranean|whole[- ]food|balanced diet|high fiber|avoid sugary drinks/i.test(text)) {
    score += 20;
    hasSignal = true;
  }

  if (/fast food|fried|processed|ultra[- ]processed|lots of soda|sugary drinks|low veggies/i.test(text)) {
    score -= 22;
    hasSignal = true;
  }

  if ((existing.fruit_veg_servings_per_day ?? 0) >= 5) {
    score += 10;
    hasSignal = true;
  }

  if ((existing.sugary_drinks_per_week ?? 0) >= 7) {
    score -= 12;
    hasSignal = true;
  }

  if (!hasSignal) return null;
  return clamp(round(score, 1), 0, 100);
};

const fallbackNutritionParser = (freeform: string): NutritionParseResult => {
  const normalized = freeform.trim();
  if (!normalized) {
    return {
      nutrition: emptyNutrition(),
      nutrition_source_map: emptyNutritionSourceMap(),
    };
  }

  const parsed: Partial<NutritionFeatures> = {
    daily_calories_est: parseNumericAfterToken(normalized, /(\d+(?:\.\d+)?)\s*(?:kcal|calories?)\b/i),
    protein_g_est: parseNumericAfterToken(normalized, /(\d+(?:\.\d+)?)\s*(?:g|grams?)\s*(?:protein)/i),
    fiber_g_est: parseNumericAfterToken(normalized, /(\d+(?:\.\d+)?)\s*(?:g|grams?)\s*(?:fiber)/i),
    added_sugar_g_est: parseNumericAfterToken(normalized, /(\d+(?:\.\d+)?)\s*(?:g|grams?)\s*(?:added\s+)?sugar/i),
    saturated_fat_g_est: parseNumericAfterToken(normalized, /(\d+(?:\.\d+)?)\s*(?:g|grams?)\s*(?:sat(?:urated)?\s*fat)/i),
    sodium_mg_est: parseNumericAfterToken(normalized, /(\d+(?:\.\d+)?)\s*(?:mg)\s*(?:sodium|salt)/i),
    fruit_veg_servings_per_day: parseServings(normalized),
    ultra_processed_freq_per_week: parseWeeklyFrequency(
      normalized,
      /(?:fast food|processed|ultra[- ]processed)\D{0,12}(\d+(?:\.\d+)?)\s*(?:x|times?)?\s*(?:\/|per)?\s*week/i,
    ),
    sugary_drinks_per_week: parseWeeklyFrequency(
      normalized,
      /(?:sugary drinks|soda|soft drinks?)\D{0,12}(\d+(?:\.\d+)?)\s*(?:x|times?)?\s*(?:\/|per)?\s*week/i,
    ),
    alcohol_drinks_per_day: parseNumericAfterToken(
      normalized,
      /(?:alcohol|drink(?:s)?)\D{0,14}(\d+(?:\.\d+)?)\s*(?:drinks?)?\s*(?:\/|per)?\s*day/i,
    ),
    diet_quality_indicator: null,
  };

  parsed.diet_quality_indicator = estimateDietQuality(normalized, parsed);

  const nutrition = nutritionFeaturesSchema.parse({
    ...emptyNutrition(),
    ...Object.fromEntries(
      NUTRITION_NUMERIC_FIELDS.map((field) => {
        const raw = parsed[field];
        return [field, sanitizeFieldNumber(field, raw ?? null)];
      }),
    ),
    notes: "Fallback nutrition parser used (rule-based).",
    warnings: [
      "Nutrition values without explicit quantities were left null or estimated conservatively.",
    ],
  });

  const nutrition_source_map = emptyNutritionSourceMap("freeform_text", 0.35, true);

  for (const field of NUTRITION_NUMERIC_FIELDS) {
    if (nutrition[field] != null) {
      nutrition_source_map[field] = {
        source: "freeform_text",
        confidence: field.includes("diet_quality_indicator") ? 0.45 : 0.6,
        derived_from_freeform: true,
      };
    }
  }

  return {
    nutrition,
    nutrition_source_map,
  };
};

const parseNutritionWithOpenAI = async (freeform: string): Promise<NutritionParseResult> => {
  const client = openAIClient();

  const response = await client.responses.create({
    model: env.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "Extract nutrition-related features from freeform user text.",
              "Critical rules:",
              "1) Do not invent precise numbers.",
              "2) If quantity is uncertain, return null and add a warning.",
              "3) If text contains ranges (e.g., 2-3/week), use midpoint only when explicit.",
              "4) diet_quality_indicator must be 0-100 when possible, else null.",
              "5) Keep notes concise and factual.",
            ].join("\n"),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: freeform,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "NutritionFeaturesExtraction",
        strict: true,
        schema: OPENAI_NUTRITION_SCHEMA,
      },
    },
  });

  const outputText = extractOpenAIOutputText(response);
  const parsed = JSON.parse(outputText) as OpenAINutritionResult;
  return nutritionFromOpenAIOutput(parsed);
};

export const parseNutritionFreeform = async (
  freeformText: string | null | undefined,
): Promise<NutritionParseResult> => {
  const freeform = freeformText?.trim() ?? "";
  if (!freeform) {
    return {
      nutrition: emptyNutrition(),
      nutrition_source_map: emptyNutritionSourceMap(),
    };
  }

  if (!env.OPENAI_API_KEY) {
    return fallbackNutritionParser(freeform);
  }

  try {
    return await parseNutritionWithOpenAI(freeform);
  } catch {
    return fallbackNutritionParser(freeform);
  }
};

export const nutritionToModelDietQuality = (dietQualityIndicator: number | null | undefined): number | null => {
  if (dietQualityIndicator == null || !Number.isFinite(dietQualityIndicator)) {
    return null;
  }

  // Stage models were trained with a compact centered feature. We map 0-100 user scale to -5..5.
  if (dietQualityIndicator >= -5 && dietQualityIndicator <= 5) {
    return dietQualityIndicator;
  }

  const scaled = (dietQualityIndicator - 50) / 10;
  return clamp(round(scaled, 2), -5, 5);
};

export const nutritionToCanonicalDietQuality = (dietQualityIndicator: number | null | undefined): number | null => {
  if (dietQualityIndicator == null || !Number.isFinite(dietQualityIndicator)) return null;
  return clamp(round(dietQualityIndicator, 1), 0, 100);
};
