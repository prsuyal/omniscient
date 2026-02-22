import OpenAI from "openai";

import { env } from "~/env";
import {
  canonicalUserInputSchema,
  type CanonicalUserInput,
  type OptionAInput,
  type SourceType,
} from "~/server/simulation/schemas";
import { nutritionToModelDietQuality } from "~/server/simulation/nutritionParser";

type ParseOptionBArgs = {
  freeformText?: string | null;
  pdfText?: string | null;
};

type SourceRecord = {
  source: SourceType;
  confidence: number;
  derived_from_freeform: boolean;
};

const FIELD_PATHS = [
  "demographics.age",
  "demographics.sex",
  "demographics.race_ethnicity",
  "demographics.location",
  "demographics.ses_pir",
  "body.height_cm",
  "body.weight_kg",
  "body.bmi",
  "vitals.sbp",
  "vitals.resting_hr",
  "labs.ldl",
  "labs.hdl",
  "labs.total_cholesterol",
  "labs.hba1c",
  "labs.egfr",
  "histories.family_history_text",
  "histories.personal_history_text",
  "histories.addiction_history_text",
  "medications_text",
  "behaviors.sleep_hours",
  "behaviors.alcohol_drinks_per_day",
  "behaviors.pa_minutes_week",
  "behaviors.diet_quality_indicator",
] as const;

const NUTRITION_FIELDS = [
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

const OPENAI_SOURCE_ENUM: SourceType[] = ["structured_form", "freeform_text", "pdf", "derived", "default"];

const sourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "confidence", "derived_from_freeform"],
  properties: {
    source: {
      type: "string",
      enum: OPENAI_SOURCE_ENUM,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    derived_from_freeform: {
      type: "boolean",
    },
  },
} as const;

const OPENAI_CANONICAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "demographics",
    "body",
    "vitals",
    "labs",
    "histories",
    "medications_text",
    "behaviors",
    "source_map",
  ],
  properties: {
    demographics: {
      type: "object",
      additionalProperties: false,
      required: ["age", "sex", "race_ethnicity", "location", "ses_pir"],
      properties: {
        age: { type: ["number", "null"] },
        sex: { type: ["string", "null"] },
        race_ethnicity: { type: ["string", "null"] },
        location: { type: ["string", "null"] },
        ses_pir: { type: ["number", "null"] },
      },
    },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["height_cm", "weight_kg", "bmi"],
      properties: {
        height_cm: { type: ["number", "null"] },
        weight_kg: { type: ["number", "null"] },
        bmi: { type: ["number", "null"] },
      },
    },
    vitals: {
      type: "object",
      additionalProperties: false,
      required: ["sbp", "resting_hr"],
      properties: {
        sbp: { type: ["number", "null"] },
        resting_hr: { type: ["number", "null"] },
      },
    },
    labs: {
      type: "object",
      additionalProperties: false,
      required: ["ldl", "hdl", "total_cholesterol", "hba1c", "egfr"],
      properties: {
        ldl: { type: ["number", "null"] },
        hdl: { type: ["number", "null"] },
        total_cholesterol: { type: ["number", "null"] },
        hba1c: { type: ["number", "null"] },
        egfr: { type: ["number", "null"] },
      },
    },
    histories: {
      type: "object",
      additionalProperties: false,
      required: ["family_history_text", "personal_history_text", "addiction_history_text"],
      properties: {
        family_history_text: { type: ["string", "null"] },
        personal_history_text: { type: ["string", "null"] },
        addiction_history_text: { type: ["string", "null"] },
      },
    },
    medications_text: { type: ["string", "null"] },
    behaviors: {
      type: "object",
      additionalProperties: false,
      required: ["sleep_hours", "alcohol_drinks_per_day", "pa_minutes_week", "diet_quality_indicator"],
      properties: {
        sleep_hours: { type: ["number", "null"] },
        alcohol_drinks_per_day: { type: ["number", "null"] },
        pa_minutes_week: { type: ["number", "null"] },
        diet_quality_indicator: { type: ["number", "null"] },
      },
    },
    source_map: {
      type: "object",
      additionalProperties: false,
      required: FIELD_PATHS,
      properties: Object.fromEntries(FIELD_PATHS.map((field) => [field, sourceSchema])),
    },
  },
} as const;

const toNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
};

const toNullableString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const round = (value: number, decimals = 2): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const deriveBmi = (heightCm: number | null, weightKg: number | null): number | null => {
  if (heightCm == null || weightKg == null || heightCm <= 0) return null;
  const meters = heightCm / 100;
  const bmi = weightKg / (meters * meters);
  return Number.isFinite(bmi) ? round(bmi, 2) : null;
};

const modelDietToUserScale = (value: number | null): number | null => {
  if (value == null) return null;
  if (value >= 0 && value <= 100) return value;
  return clamp(round(value * 10 + 50, 1), 0, 100);
};

const normalizeSex = (value: string | null): string | null => {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (["male", "man", "m"].includes(text)) return "Male";
  if (["female", "woman", "f"].includes(text)) return "Female";
  if (["other", "non-binary", "nonbinary", "nb"].includes(text)) return "Other";
  return value.trim();
};

const normalizeRace = (value: string | null): string | null => {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (text.includes("white")) return "Non-Hispanic White";
  if (text.includes("black")) return "Non-Hispanic Black";
  if (text.includes("mexican")) return "Mexican American";
  if (text.includes("hispanic")) return "Other Hispanic";
  if (text.includes("asian")) return "Non-Hispanic Asian";
  if (text.includes("multi") || text.includes("other")) return "Other / Multiracial";
  return value.trim();
};

const parseSesPir = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const match = /-?\d+(?:\.\d+)?/.exec(value);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
};

const emptyNutrition = () => ({
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
  notes: "",
  warnings: [],
});

const emptySourceMap = (
  source: SourceType = "default",
  confidence = 0,
  derivedFromFreeform = false,
) => {
  return Object.fromEntries(
    FIELD_PATHS.map((fieldPath) => [
      fieldPath,
      {
        source,
        confidence,
        derived_from_freeform: derivedFromFreeform,
      },
    ]),
  ) as Record<string, SourceRecord>;
};

const emptyNutritionSourceMap = (
  source: SourceType = "default",
  confidence = 0,
  derivedFromFreeform = false,
) => {
  return Object.fromEntries(
    NUTRITION_FIELDS.map((field) => [
      field,
      {
        source,
        confidence,
        derived_from_freeform: derivedFromFreeform,
      },
    ]),
  ) as Record<string, SourceRecord>;
};

const emptyCanonicalInput = (): CanonicalUserInput =>
  canonicalUserInputSchema.parse({
    demographics: {
      age: null,
      sex: null,
      race_ethnicity: null,
      location: null,
      ses_pir: null,
    },
    body: {
      height_cm: null,
      weight_kg: null,
      bmi: null,
    },
    vitals: {
      sbp: null,
      resting_hr: null,
    },
    labs: {
      ldl: null,
      hdl: null,
      total_cholesterol: null,
      hba1c: null,
      egfr: null,
    },
    histories: {
      family_history_text: null,
      personal_history_text: null,
      addiction_history_text: null,
    },
    medications_text: null,
    behaviors: {
      sleep_hours: null,
      alcohol_drinks_per_day: null,
      pa_minutes_week: null,
      diet_quality_indicator: null,
    },
    nutrition: emptyNutrition(),
    source_map: emptySourceMap(),
    nutrition_source_map: emptyNutritionSourceMap(),
  });

const setSource = (
  sourceMap: Record<string, SourceRecord>,
  fieldPath: (typeof FIELD_PATHS)[number],
  source: SourceType,
  confidence: number,
  derivedFromFreeform = false,
) => {
  sourceMap[fieldPath] = {
    source,
    confidence: clamp(confidence, 0, 1),
    derived_from_freeform: derivedFromFreeform,
  };
};

const extractOpenAIOutputText = (response: unknown): string => {
  const direct = (response as { output_text?: string })?.output_text;
  if (typeof direct === "string" && direct.trim().length > 0) return direct;

  const outputs = (response as { output?: Array<{ content?: Array<{ text?: string }> }> })?.output;
  if (!outputs?.length) throw new Error("OpenAI response had no output payload.");

  const chunks = outputs.flatMap((item) => item.content ?? []).map((chunk) => chunk.text).filter(Boolean);
  const merged = chunks.join("\n").trim();

  if (!merged) throw new Error("OpenAI response output content was empty.");
  return merged;
};

const asSourceMap = (value: unknown): Record<string, SourceRecord> => {
  if (!value || typeof value !== "object") return {};

  const output: Record<string, SourceRecord> = {};
  for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const source = OPENAI_SOURCE_ENUM.includes(row.source as SourceType)
      ? (row.source as SourceType)
      : "default";
    const confidence = toNullableNumber(row.confidence) ?? 0;
    const derived = typeof row.derived_from_freeform === "boolean" ? row.derived_from_freeform : false;

    output[field] = {
      source,
      confidence: clamp(confidence, 0, 1),
      derived_from_freeform: derived,
    };
  }

  return output;
};

const mergeAndNormalizeCanonical = (candidate: unknown): CanonicalUserInput => {
  const parsed = candidate as Record<string, unknown>;
  const base = emptyCanonicalInput();

  const demographics = (parsed.demographics ?? {}) as Record<string, unknown>;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  const vitals = (parsed.vitals ?? {}) as Record<string, unknown>;
  const labs = (parsed.labs ?? {}) as Record<string, unknown>;
  const histories = (parsed.histories ?? {}) as Record<string, unknown>;
  const behaviors = (parsed.behaviors ?? {}) as Record<string, unknown>;

  const sourceMapRaw = asSourceMap(parsed.source_map);

  const merged: CanonicalUserInput = {
    ...base,
    demographics: {
      ...base.demographics,
      age: toNullableNumber(demographics.age),
      sex: normalizeSex(toNullableString(demographics.sex)),
      race_ethnicity: normalizeRace(toNullableString(demographics.race_ethnicity)),
      location: toNullableString(demographics.location),
      ses_pir: toNullableNumber(demographics.ses_pir),
    },
    body: {
      ...base.body,
      height_cm: toNullableNumber(body.height_cm),
      weight_kg: toNullableNumber(body.weight_kg),
      bmi: toNullableNumber(body.bmi),
    },
    vitals: {
      ...base.vitals,
      sbp: toNullableNumber(vitals.sbp),
      resting_hr: toNullableNumber(vitals.resting_hr),
    },
    labs: {
      ...base.labs,
      ldl: toNullableNumber(labs.ldl),
      hdl: toNullableNumber(labs.hdl),
      total_cholesterol: toNullableNumber(labs.total_cholesterol),
      hba1c: toNullableNumber(labs.hba1c),
      egfr: toNullableNumber(labs.egfr),
    },
    histories: {
      ...base.histories,
      family_history_text: toNullableString(histories.family_history_text),
      personal_history_text: toNullableString(histories.personal_history_text),
      addiction_history_text: toNullableString(histories.addiction_history_text),
    },
    medications_text: toNullableString(parsed.medications_text),
    behaviors: {
      ...base.behaviors,
      sleep_hours: toNullableNumber(behaviors.sleep_hours),
      alcohol_drinks_per_day: toNullableNumber(behaviors.alcohol_drinks_per_day),
      pa_minutes_week: toNullableNumber(behaviors.pa_minutes_week),
      diet_quality_indicator: nutritionToModelDietQuality(toNullableNumber(behaviors.diet_quality_indicator)),
    },
    nutrition: base.nutrition,
    source_map: {
      ...base.source_map,
      ...sourceMapRaw,
    },
    nutrition_source_map: base.nutrition_source_map,
  };

  if (merged.body.bmi == null) {
    const derived = deriveBmi(merged.body.height_cm, merged.body.weight_kg);
    if (derived != null) {
      merged.body.bmi = derived;
      setSource(merged.source_map, "body.bmi", "derived", 0.95, false);
    }
  }

  if (merged.behaviors.diet_quality_indicator != null) {
    merged.nutrition.diet_quality_indicator = modelDietToUserScale(merged.behaviors.diet_quality_indicator);
    merged.nutrition_source_map.diet_quality_indicator = {
      source: "derived",
      confidence: 0.8,
      derived_from_freeform: false,
    };
  }

  for (const fieldPath of FIELD_PATHS) {
    if (!merged.source_map[fieldPath]) {
      setSource(merged.source_map, fieldPath, "default", 0, false);
    }
  }

  return canonicalUserInputSchema.parse(merged);
};

const extractByRegex = (text: string, patterns: RegExp[]): number | null => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

export const fallbackOptionBFromTextOnly = (freeformText: string, pdfText?: string | null): CanonicalUserInput => {
  const mergedText = `${freeformText ?? ""}\n${pdfText ?? ""}`.trim();
  const normalized = mergedText.toLowerCase();

  const base = emptyCanonicalInput();
  const sourceMap = emptySourceMap();

  const age = extractByRegex(mergedText, [/\b(\d{1,3})\s*(?:years? old|year old|yo|y\/o)\b/i]);
  const ldl = extractByRegex(mergedText, [/\bldl\D{0,8}(\d+(?:\.\d+)?)\b/i]);
  const hdl = extractByRegex(mergedText, [/\bhdl\D{0,8}(\d+(?:\.\d+)?)\b/i]);
  const totalCholesterol = extractByRegex(mergedText, [
    /\btotal\s+chol(?:esterol)?\D{0,8}(\d+(?:\.\d+)?)\b/i,
    /\btchol\D{0,8}(\d+(?:\.\d+)?)\b/i,
  ]);
  const sbp = extractByRegex(mergedText, [
    /\bsbp\D{0,8}(\d+(?:\.\d+)?)\b/i,
    /\bblood pressure\D{0,8}(\d{2,3})(?:\s*\/\s*\d{2,3})?\b/i,
  ]);
  const restingHr = extractByRegex(mergedText, [/\bresting\s*(?:heart\s*rate|hr)\D{0,8}(\d+(?:\.\d+)?)\b/i]);
  const hba1c = extractByRegex(mergedText, [/\bhba1c\D{0,8}(\d+(?:\.\d+)?)\b/i, /\ba1c\D{0,8}(\d+(?:\.\d+)?)\b/i]);
  const egfr = extractByRegex(mergedText, [/\begfr\D{0,8}(\d+(?:\.\d+)?)\b/i]);
  const sleepHours = extractByRegex(mergedText, [/\bsleep\D{0,8}(\d+(?:\.\d+)?)\s*(?:h|hr|hours)?\b/i]);
  const alcoholPerDay = extractByRegex(mergedText, [
    /\balcohol\D{0,12}(\d+(?:\.\d+)?)\s*(?:drinks?\s*\/\s*day|drinks?\s*per\s*day)?\b/i,
    /\bdrinks?\s*\/\s*day\D{0,8}(\d+(?:\.\d+)?)\b/i,
  ]);
  const paMinutesWeek = extractByRegex(mergedText, [
    /\b(?:exercise|physical activity|activity)\D{0,18}(\d+(?:\.\d+)?)\s*(?:min|mins|minutes)\s*(?:\/|per)?\s*week\b/i,
  ]);

  base.demographics.age = age;
  if (age != null) setSource(sourceMap, "demographics.age", "freeform_text", 0.5, true);

  if (normalized.includes(" female") || normalized.includes(" woman")) {
    base.demographics.sex = "Female";
    setSource(sourceMap, "demographics.sex", "freeform_text", 0.5, true);
  } else if (normalized.includes(" male") || normalized.includes(" man")) {
    base.demographics.sex = "Male";
    setSource(sourceMap, "demographics.sex", "freeform_text", 0.5, true);
  }

  base.labs.ldl = ldl;
  if (ldl != null) setSource(sourceMap, "labs.ldl", "freeform_text", 0.55, true);

  base.labs.hdl = hdl;
  if (hdl != null) setSource(sourceMap, "labs.hdl", "freeform_text", 0.55, true);

  base.labs.total_cholesterol = totalCholesterol;
  if (totalCholesterol != null) setSource(sourceMap, "labs.total_cholesterol", "freeform_text", 0.55, true);

  base.vitals.sbp = sbp;
  if (sbp != null) setSource(sourceMap, "vitals.sbp", "freeform_text", 0.55, true);

  base.vitals.resting_hr = restingHr;
  if (restingHr != null) setSource(sourceMap, "vitals.resting_hr", "freeform_text", 0.5, true);

  base.labs.hba1c = hba1c;
  if (hba1c != null) setSource(sourceMap, "labs.hba1c", "freeform_text", 0.55, true);

  base.labs.egfr = egfr;
  if (egfr != null) setSource(sourceMap, "labs.egfr", "freeform_text", 0.55, true);

  base.behaviors.sleep_hours = sleepHours;
  if (sleepHours != null) setSource(sourceMap, "behaviors.sleep_hours", "freeform_text", 0.45, true);

  base.behaviors.alcohol_drinks_per_day = alcoholPerDay;
  if (alcoholPerDay != null)
    setSource(sourceMap, "behaviors.alcohol_drinks_per_day", "freeform_text", 0.45, true);

  base.behaviors.pa_minutes_week = paMinutesWeek;
  if (paMinutesWeek != null) setSource(sourceMap, "behaviors.pa_minutes_week", "freeform_text", 0.45, true);

  base.source_map = sourceMap;
  return canonicalUserInputSchema.parse(base);
};

const openAIClient = () => {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
};

export const parseStructuredOptionA = (payload: OptionAInput): CanonicalUserInput => {
  const sourceMap = emptySourceMap();
  const nutritionSourceMap = emptyNutritionSourceMap();

  const heightValue = toNullableNumber(payload.heightValue);
  const weightValue = toNullableNumber(payload.weightValue);

  let heightCm: number | null = null;
  if (heightValue != null) {
    if (payload.heightUnit === "in") {
      heightCm = round(heightValue * 2.54, 2);
    } else if (payload.heightUnit === "ft") {
      heightCm = round(heightValue * 30.48, 2);
    } else {
      heightCm = round(heightValue, 2);
    }
  }

  let weightKg: number | null = null;
  if (weightValue != null) {
    weightKg = payload.weightUnit === "lb" ? round(weightValue * 0.45359237, 2) : round(weightValue, 2);
  }

  const rawDietQuality = toNullableNumber(payload.dietQualityIndicator);
  const modelDietQuality = nutritionToModelDietQuality(rawDietQuality);

  const canonical: CanonicalUserInput = {
    demographics: {
      age: toNullableNumber(payload.age),
      sex: normalizeSex(payload.sex ?? null),
      race_ethnicity: normalizeRace(payload.raceEthnicity ?? null),
      location: toNullableString(payload.location),
      ses_pir: parseSesPir(payload.sesPirText ?? null),
    },
    body: {
      height_cm: heightCm,
      weight_kg: weightKg,
      bmi: deriveBmi(heightCm, weightKg),
    },
    vitals: {
      sbp: toNullableNumber(payload.sbp),
      resting_hr: toNullableNumber(payload.restingHr),
    },
    labs: {
      ldl: toNullableNumber(payload.ldl),
      hdl: toNullableNumber(payload.hdl),
      total_cholesterol: toNullableNumber(payload.totalCholesterol),
      hba1c: toNullableNumber(payload.hba1c),
      egfr: toNullableNumber(payload.egfr),
    },
    histories: {
      family_history_text: toNullableString(payload.familyHistory),
      personal_history_text: toNullableString(payload.preExistingConditions),
      addiction_history_text: null,
    },
    medications_text: toNullableString(payload.medications),
    behaviors: {
      sleep_hours: toNullableNumber(payload.sleepHours),
      alcohol_drinks_per_day: toNullableNumber(payload.alcoholDrinksPerDay),
      pa_minutes_week: toNullableNumber(payload.paMinutesWeek),
      diet_quality_indicator: modelDietQuality,
    },
    nutrition: {
      ...emptyNutrition(),
      diet_quality_indicator: modelDietToUserScale(modelDietQuality),
      alcohol_drinks_per_day: toNullableNumber(payload.alcoholDrinksPerDay),
      notes: payload.nutritionFreeform?.trim() ? "Nutrition freeform submitted for parser." : "",
    },
    source_map: sourceMap,
    nutrition_source_map: nutritionSourceMap,
  };

  if (canonical.demographics.age != null) setSource(sourceMap, "demographics.age", "structured_form", 1);
  if (canonical.demographics.sex != null) setSource(sourceMap, "demographics.sex", "structured_form", 0.99);
  if (canonical.demographics.race_ethnicity != null)
    setSource(sourceMap, "demographics.race_ethnicity", "structured_form", 0.99);
  if (canonical.demographics.location != null) setSource(sourceMap, "demographics.location", "structured_form", 0.95);
  if (canonical.demographics.ses_pir != null) setSource(sourceMap, "demographics.ses_pir", "structured_form", 0.9);

  if (canonical.body.height_cm != null) setSource(sourceMap, "body.height_cm", "structured_form", 0.99);
  if (canonical.body.weight_kg != null) setSource(sourceMap, "body.weight_kg", "structured_form", 0.99);
  if (canonical.body.bmi != null) {
    setSource(
      sourceMap,
      "body.bmi",
      canonical.body.height_cm != null && canonical.body.weight_kg != null ? "derived" : "structured_form",
      canonical.body.height_cm != null && canonical.body.weight_kg != null ? 0.95 : 0.99,
    );
  }

  if (canonical.vitals.sbp != null) setSource(sourceMap, "vitals.sbp", "structured_form", 0.99);
  if (canonical.vitals.resting_hr != null) setSource(sourceMap, "vitals.resting_hr", "structured_form", 0.99);

  if (canonical.labs.ldl != null) setSource(sourceMap, "labs.ldl", "structured_form", 0.99);
  if (canonical.labs.hdl != null) setSource(sourceMap, "labs.hdl", "structured_form", 0.99);
  if (canonical.labs.total_cholesterol != null)
    setSource(sourceMap, "labs.total_cholesterol", "structured_form", 0.99);
  if (canonical.labs.hba1c != null) setSource(sourceMap, "labs.hba1c", "structured_form", 0.99);
  if (canonical.labs.egfr != null) setSource(sourceMap, "labs.egfr", "structured_form", 0.99);

  if (canonical.histories.family_history_text != null)
    setSource(sourceMap, "histories.family_history_text", "structured_form", 0.9);
  if (canonical.histories.personal_history_text != null)
    setSource(sourceMap, "histories.personal_history_text", "structured_form", 0.9);

  if (canonical.medications_text != null) setSource(sourceMap, "medications_text", "structured_form", 0.9);

  if (canonical.behaviors.sleep_hours != null) setSource(sourceMap, "behaviors.sleep_hours", "structured_form", 0.9);
  if (canonical.behaviors.alcohol_drinks_per_day != null)
    setSource(sourceMap, "behaviors.alcohol_drinks_per_day", "structured_form", 0.9);
  if (canonical.behaviors.pa_minutes_week != null)
    setSource(sourceMap, "behaviors.pa_minutes_week", "structured_form", 0.9);
  if (canonical.behaviors.diet_quality_indicator != null)
    setSource(sourceMap, "behaviors.diet_quality_indicator", "structured_form", 0.85);

  if (canonical.nutrition.diet_quality_indicator != null) {
    canonical.nutrition_source_map.diet_quality_indicator = {
      source: "structured_form",
      confidence: 0.85,
      derived_from_freeform: false,
    };
  }

  if (canonical.nutrition.alcohol_drinks_per_day != null) {
    canonical.nutrition_source_map.alcohol_drinks_per_day = {
      source: "structured_form",
      confidence: 0.9,
      derived_from_freeform: false,
    };
  }

  return canonicalUserInputSchema.parse(canonical);
};

export const parseOptionBWithOpenAI = async ({ freeformText, pdfText }: ParseOptionBArgs): Promise<CanonicalUserInput> => {
  const freeform = (freeformText ?? "").trim();
  const pdf = (pdfText ?? "").trim();

  if (!freeform && !pdf) {
    return emptyCanonicalInput();
  }

  const client = openAIClient();

  const systemPrompt = [
    "You extract patient baseline data into the provided JSON schema.",
    "Rules:",
    "1) Only use facts explicitly present in the input text.",
    "2) If a value is missing/ambiguous, return null.",
    "3) Never infer missing lab values, diagnoses, demographics, or medications.",
    "4) Units: return height_cm and weight_kg; convert only if unit is explicit.",
    "5) Populate source_map for every field using freeform_text or pdf.",
    "6) confidence must be in [0,1].",
  ].join("\n");

  const userPrompt = ["FREEFORM_TEXT:", freeform || "<empty>", "", "PDF_TEXT:", pdf || "<empty>"].join("\n");

  const response = await client.responses.create({
    model: env.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userPrompt }],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "CanonicalUserInput",
        strict: true,
        schema: OPENAI_CANONICAL_SCHEMA,
      },
    },
  });

  const outputText = extractOpenAIOutputText(response);
  const parsed = JSON.parse(outputText) as unknown;
  return mergeAndNormalizeCanonical(parsed);
};
