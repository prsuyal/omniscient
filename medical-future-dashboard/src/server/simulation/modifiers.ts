import OpenAI from "openai";

import { env } from "~/env";
import type { CanonicalUserInput, ModifierCategory, ModifierDefinition } from "~/server/simulation/schemas";

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const ALLOWED_DELTA_PATHS = [
  "behaviors.sleep_hours",
  "behaviors.alcohol_drinks_per_day",
  "behaviors.pa_minutes_week",
  "behaviors.diet_quality_indicator",
  "nutrition.diet_quality_indicator",
  "nutrition.sugary_drinks_per_week",
  "body.bmi",
  "vitals.sbp",
  "vitals.resting_hr",
  "labs.ldl",
  "labs.hdl",
  "labs.total_cholesterol",
  "labs.hba1c",
  "labs.egfr",
  "derived.current_smoker",
  "derived.former_smoker",
  "derived.medication_use",
] as const;

const CATEGORY_ENUM: ModifierCategory[] = [
  "breaking_negative_habits",
  "positive_habits_non_medical",
  "medication_prescribed",
  "surgical_treatments",
];

const MIN_TOTAL_MODIFIERS = 12;
const TARGET_OPENAI_ADDITIONAL = 14;

type ProfileSignals = {
  hypertension: boolean;
  diabetes: boolean;
  prediabetes: boolean;
  dyslipidemia: boolean;
  obesity: boolean;
  severeObesity: boolean;
  chronicKidneyDisease: boolean;
  smoking: boolean;
  highAlcohol: boolean;
  inactivity: boolean;
  poorDiet: boolean;
  familyCardiometabolicHistory: boolean;
  liverRisk: boolean;
};

const makeModifier = (input: {
  id: string;
  category: ModifierCategory;
  title: string;
  description: string;
  enabledByDefault?: boolean;
  deltas: Record<string, number>;
}): ModifierDefinition => ({
  id: input.id,
  category: input.category,
  title: input.title,
  description: input.description,
  enabledByDefault: input.enabledByDefault ?? false,
  deltas: input.deltas,
});

const toId = (value: string): string => {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "modifier";
};

const joinedHistoryText = (canonical: CanonicalUserInput): string => {
  return [
    canonical.histories.personal_history_text,
    canonical.histories.family_history_text,
    canonical.histories.addiction_history_text,
    canonical.medications_text,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
};

const hasSmokingSignal = (canonical: CanonicalUserInput): boolean => {
  const text = [
    canonical.histories.addiction_history_text,
    canonical.histories.personal_history_text,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  return /(smok|cigarette|tobacco|vape)/.test(text);
};

const inferProfileSignals = (canonical: CanonicalUserInput): ProfileSignals => {
  const historyText = joinedHistoryText(canonical);
  const hba1c = canonical.labs.hba1c ?? null;
  const sbp = canonical.vitals.sbp ?? null;
  const ldl = canonical.labs.ldl ?? null;
  const hdl = canonical.labs.hdl ?? null;
  const totalCholesterol = canonical.labs.total_cholesterol ?? null;
  const egfr = canonical.labs.egfr ?? null;
  const bmi = canonical.body.bmi ?? null;
  const paMinutes = canonical.behaviors.pa_minutes_week ?? 0;
  const alcoholPerDay =
    canonical.behaviors.alcohol_drinks_per_day ??
    canonical.nutrition.alcohol_drinks_per_day ??
    0;
  const dietQuality = canonical.nutrition.diet_quality_indicator;
  const sugaryDrinks = canonical.nutrition.sugary_drinks_per_week ?? 0;
  const familyHistory = canonical.histories.family_history_text?.toLowerCase() ?? "";

  const diabetes = (hba1c != null && hba1c >= 6.5) || /\b(diabetes|type 1 diabetes|type 2 diabetes)\b/.test(historyText);
  const prediabetes =
    !diabetes &&
    (((hba1c ?? 0) >= 5.7 && (hba1c ?? 0) < 6.5) || /\bprediabet/i.test(historyText));

  const signals: ProfileSignals = {
    hypertension:
      (sbp != null && sbp >= 130) ||
      /\b(hypertension|high blood pressure|primary hypertension|htn)\b/.test(historyText),
    diabetes,
    prediabetes,
    dyslipidemia:
      (ldl != null && ldl >= 130) ||
      (totalCholesterol != null && totalCholesterol >= 200) ||
      (hdl != null && hdl < 40) ||
      /\b(dyslipidemia|hyperlipidemia|high cholesterol)\b/.test(historyText),
    obesity:
      (bmi != null && bmi >= 30) ||
      /\b(obesity|obese|overweight)\b/.test(historyText),
    severeObesity:
      (bmi != null && bmi >= 35) ||
      /\b(morbid obesity|severe obesity|class iii obesity)\b/.test(historyText),
    chronicKidneyDisease:
      (egfr != null && egfr < 60) ||
      /\b(ckd|chronic kidney disease|kidney disease|renal insufficiency)\b/.test(historyText),
    smoking: hasSmokingSignal(canonical),
    highAlcohol:
      alcoholPerDay > 1.5 ||
      /\b(heavy alcohol|alcohol use disorder|binge drinking)\b/.test(historyText),
    inactivity: paMinutes < 120,
    poorDiet:
      dietQuality == null || dietQuality < 65 || sugaryDrinks > 4 || /\b(poor diet|processed food)\b/.test(historyText),
    familyCardiometabolicHistory:
      /\b(heart|cardiac|stroke|hypertension|diabetes|cholesterol)\b/.test(familyHistory),
    liverRisk:
      alcoholPerDay > 1 || /\b(nafld|fatty liver|liver disease|hepatic)\b/.test(historyText),
  };

  return signals;
};

const baseModifiers = (canonical: CanonicalUserInput): ModifierDefinition[] => {
  const signals = inferProfileSignals(canonical);
  const modifiers: ModifierDefinition[] = [];

  if ((canonical.behaviors.alcohol_drinks_per_day ?? 0) > 0.5 || signals.highAlcohol) {
    modifiers.push(
      makeModifier({
        id: "alcohol-reduction",
        category: "breaking_negative_habits",
        title: "Reduce Alcohol Intake",
        description: "Reduce average daily alcohol use to lower cardiometabolic and liver risk over time.",
        deltas: {
          "behaviors.alcohol_drinks_per_day": -1.2,
          "vitals.sbp": -3,
          "labs.hba1c": -0.2,
        },
      }),
    );
  }

  if (signals.smoking) {
    modifiers.push(
      makeModifier({
        id: "smoking-cessation",
        category: "breaking_negative_habits",
        title: "Smoking Cessation",
        description: "Modeled smoking cessation scenario for risk simulation.",
        deltas: {
          "derived.current_smoker": -1,
          "derived.former_smoker": 1,
          "vitals.sbp": -4,
          "vitals.resting_hr": -3,
        },
      }),
    );
  }

  if ((canonical.behaviors.sleep_hours ?? 7) < 7) {
    modifiers.push(
      makeModifier({
        id: "sleep-regularization",
        category: "breaking_negative_habits",
        title: "Sleep Regularization",
        description: "Shift from chronically short sleep toward consistent 7-8 hour sleep windows.",
        deltas: {
          "behaviors.sleep_hours": 1.4,
          "vitals.resting_hr": -3,
          "vitals.sbp": -2,
        },
      }),
    );
  }

  if ((canonical.behaviors.pa_minutes_week ?? 0) < 150 || signals.inactivity) {
    modifiers.push(
      makeModifier({
        id: "exercise-increase",
        category: "positive_habits_non_medical",
        title: "Increase Weekly Physical Activity",
        description: "Increase moderate physical activity to guideline-level weekly volume.",
        deltas: {
          "behaviors.pa_minutes_week": 150,
          "body.bmi": -1.2,
          "vitals.sbp": -3,
          "labs.hba1c": -0.3,
        },
      }),
    );
  }

  const lowDietQuality =
    canonical.nutrition.diet_quality_indicator == null || canonical.nutrition.diet_quality_indicator < 65;

  if (lowDietQuality || (canonical.nutrition.sugary_drinks_per_week ?? 0) > 2 || signals.poorDiet) {
    modifiers.push(
      makeModifier({
        id: "diet-upgrade",
        category: "positive_habits_non_medical",
        title: "Diet Quality Improvement",
        description: "Shift dietary pattern toward higher fiber and lower sugar and ultra-processed intake.",
        deltas: {
          "nutrition.diet_quality_indicator": 18,
          "behaviors.diet_quality_indicator": 1.4,
          "nutrition.sugary_drinks_per_week": -3,
          "labs.ldl": -12,
          "labs.hdl": 4,
        },
      }),
    );
  }

  if ((canonical.vitals.sbp ?? 120) > 128 || (canonical.vitals.resting_hr ?? 72) > 82 || signals.hypertension) {
    modifiers.push(
      makeModifier({
        id: "stress-reduction",
        category: "positive_habits_non_medical",
        title: "Stress Regulation Routine",
        description: "Model regular stress-management habits (breathing, mindfulness, and recovery blocks).",
        deltas: {
          "vitals.sbp": -5,
          "vitals.resting_hr": -4,
          "behaviors.sleep_hours": 0.6,
        },
      }),
    );
  }

  if ((canonical.labs.ldl ?? 0) >= 130 || signals.dyslipidemia) {
    modifiers.push(
      makeModifier({
        id: "statin-therapy",
        category: "medication_prescribed",
        title: "Lipid-Lowering Prescription Path",
        description: "Modeled prescribed lipid-lowering regimen pathway.",
        deltas: {
          "labs.ldl": -35,
          "labs.total_cholesterol": -28,
          "derived.medication_use": 1,
        },
      }),
    );
  }

  if ((canonical.vitals.sbp ?? 0) >= 130 || signals.hypertension) {
    modifiers.push(
      makeModifier({
        id: "antihypertensive-therapy",
        category: "medication_prescribed",
        title: "Blood Pressure Prescription Path",
        description: "Modeled antihypertensive treatment pathway.",
        deltas: {
          "vitals.sbp": -14,
          "labs.egfr": 1.5,
          "derived.medication_use": 1,
        },
      }),
    );
  }

  if ((canonical.labs.hba1c ?? 0) >= 5.8 || signals.diabetes || signals.prediabetes) {
    modifiers.push(
      makeModifier({
        id: "glucose-lowering-therapy",
        category: "medication_prescribed",
        title: "Glucose-Lowering Prescription Path",
        description: "Modeled glucose-lowering therapy pathway.",
        deltas: {
          "labs.hba1c": -0.9,
          "body.bmi": -1,
          "derived.medication_use": 1,
        },
      }),
    );
  }

  if ((canonical.body.bmi ?? 0) >= 35 || signals.severeObesity) {
    modifiers.push(
      makeModifier({
        id: "metabolic-surgery-path",
        category: "surgical_treatments",
        title: "Metabolic Surgery Path (When Clinically Appropriate)",
        description: "Modeled surgical pathway with large BMI and metabolic shifts.",
        deltas: {
          "body.bmi": -8,
          "labs.hba1c": -1.1,
          "vitals.sbp": -10,
          "labs.ldl": -18,
        },
      }),
    );
  }

  return modifiers;
};

const buildDeterministicFallbackModifiers = (
  canonical: CanonicalUserInput,
  signals: ProfileSignals,
): ModifierDefinition[] => {
  const candidates: ModifierDefinition[] = [];

  if (signals.hypertension) {
    candidates.push(
      makeModifier({
        id: "dash-sodium-pattern",
        category: "positive_habits_non_medical",
        title: "DASH + Sodium Restriction Program",
        description: "Structured dietary pattern and sodium reduction for blood-pressure control.",
        deltas: {
          "vitals.sbp": -7,
          "behaviors.diet_quality_indicator": 1.1,
          "nutrition.sugary_drinks_per_week": -1.5,
        },
      }),
      makeModifier({
        id: "home-bp-monitoring-routine",
        category: "positive_habits_non_medical",
        title: "Home BP Monitoring + Titration Routine",
        description: "Frequent blood-pressure tracking paired with clinician-guided treatment adjustment.",
        deltas: {
          "vitals.sbp": -6,
          "vitals.resting_hr": -2,
          "derived.medication_use": 1,
        },
      }),
      makeModifier({
        id: "ace-arb-prescription-path",
        category: "medication_prescribed",
        title: "ACE/ARB Prescription Path",
        description: "Modeled renin-angiotensin pathway treatment for blood pressure and renal protection.",
        deltas: {
          "vitals.sbp": -11,
          "labs.egfr": 3,
          "derived.medication_use": 1,
        },
      }),
      makeModifier({
        id: "thiazide-add-on-path",
        category: "medication_prescribed",
        title: "Thiazide Add-On Path",
        description: "Modeled diuretic add-on for persistent systolic blood-pressure elevation.",
        deltas: {
          "vitals.sbp": -9,
          "vitals.resting_hr": -1,
          "derived.medication_use": 1,
        },
      }),
    );
  }

  if (signals.diabetes || signals.prediabetes) {
    candidates.push(
      makeModifier({
        id: "carb-aware-meal-structure",
        category: "positive_habits_non_medical",
        title: "Carbohydrate-Structured Meal Plan",
        description: "Lower-glycemic meal structure with portion targeting and post-meal glucose control.",
        deltas: {
          "labs.hba1c": -0.4,
          "behaviors.diet_quality_indicator": 0.8,
          "nutrition.sugary_drinks_per_week": -2,
        },
      }),
      makeModifier({
        id: "metformin-optimization-path",
        category: "medication_prescribed",
        title: "Metformin Optimization Path",
        description: "Modeled first-line antihyperglycemic pathway with gradual dose optimization.",
        deltas: {
          "labs.hba1c": -0.8,
          "body.bmi": -0.8,
          "derived.medication_use": 1,
        },
      }),
      makeModifier({
        id: "glp1-receptor-agonist-path",
        category: "medication_prescribed",
        title: "GLP-1 Receptor Agonist Path",
        description: "Modeled incretin-based pathway for glucose and weight reduction.",
        deltas: {
          "labs.hba1c": -0.9,
          "body.bmi": -2.8,
          "vitals.sbp": -4,
          "derived.medication_use": 1,
        },
      }),
      makeModifier({
        id: "sglt2-protective-path",
        category: "medication_prescribed",
        title: "SGLT2 Cardio-Renal Protective Path",
        description: "Modeled SGLT2 inhibitor pathway for glycemic and kidney/cardiovascular protection.",
        deltas: {
          "labs.hba1c": -0.5,
          "labs.egfr": 3.5,
          "vitals.sbp": -3,
          "derived.medication_use": 1,
        },
      }),
    );
  }

  if (signals.dyslipidemia) {
    candidates.push(
      makeModifier({
        id: "fiber-sterol-lipid-plan",
        category: "positive_habits_non_medical",
        title: "Soluble Fiber + Sterol Lipid Plan",
        description: "Dietary lipid-lowering pattern emphasizing soluble fiber and sterol-rich foods.",
        deltas: {
          "labs.ldl": -10,
          "labs.hdl": 2,
          "behaviors.diet_quality_indicator": 0.7,
        },
      }),
      makeModifier({
        id: "ezetimibe-add-on-path",
        category: "medication_prescribed",
        title: "Ezetimibe Add-On Path",
        description: "Modeled non-statin lipid-lowering add-on for persistent LDL elevation.",
        deltas: {
          "labs.ldl": -22,
          "labs.total_cholesterol": -18,
          "derived.medication_use": 1,
        },
      }),
    );
  }

  if (signals.chronicKidneyDisease) {
    candidates.push(
      makeModifier({
        id: "renal-sodium-protein-plan",
        category: "positive_habits_non_medical",
        title: "Renal Sodium/Protein Moderation Plan",
        description: "Kidney-focused dietary plan with sodium and protein moderation.",
        deltas: {
          "labs.egfr": 2.2,
          "vitals.sbp": -4,
          "behaviors.diet_quality_indicator": 0.5,
        },
      }),
      makeModifier({
        id: "nephroprotective-medication-path",
        category: "medication_prescribed",
        title: "Nephroprotective Medication Path",
        description: "Modeled nephroprotective pharmacologic strategy for CKD risk mitigation.",
        deltas: {
          "labs.egfr": 4.2,
          "vitals.sbp": -5,
          "derived.medication_use": 1,
        },
      }),
    );
  }

  if (signals.smoking) {
    candidates.push(
      makeModifier({
        id: "nicotine-replacement-counseling",
        category: "breaking_negative_habits",
        title: "Nicotine Replacement + Counseling Program",
        description: "Combined pharmacologic and behavioral smoking cessation pathway.",
        deltas: {
          "derived.current_smoker": -1,
          "derived.former_smoker": 1,
          "vitals.sbp": -3,
          "vitals.resting_hr": -2,
        },
      }),
    );
  }

  if (signals.highAlcohol || signals.liverRisk) {
    candidates.push(
      makeModifier({
        id: "alcohol-abstinence-program",
        category: "breaking_negative_habits",
        title: "Alcohol Abstinence Program",
        description: "Complete alcohol abstinence pathway with relapse-prevention supports.",
        deltas: {
          "behaviors.alcohol_drinks_per_day": -2.2,
          "vitals.sbp": -4,
          "labs.hba1c": -0.2,
        },
      }),
    );
  }

  if (signals.obesity) {
    candidates.push(
      makeModifier({
        id: "intensive-weight-management-path",
        category: "positive_habits_non_medical",
        title: "Intensive Weight Management Program",
        description: "Structured coaching pathway with meal planning and progressive activity targets.",
        deltas: {
          "body.bmi": -3,
          "vitals.sbp": -5,
          "labs.hba1c": -0.5,
          "labs.ldl": -8,
        },
      }),
    );
  }

  if (signals.severeObesity) {
    candidates.push(
      makeModifier({
        id: "bariatric-evaluation-path",
        category: "surgical_treatments",
        title: "Bariatric Evaluation Path",
        description: "Modeled bariatric referral pathway when severe obesity criteria are present.",
        deltas: {
          "body.bmi": -7,
          "labs.hba1c": -1,
          "vitals.sbp": -9,
          "labs.ldl": -14,
        },
      }),
    );
  }

  if (signals.poorDiet) {
    candidates.push(
      makeModifier({
        id: "mediterranean-pattern-shift",
        category: "positive_habits_non_medical",
        title: "Mediterranean Pattern Shift",
        description: "Higher unsaturated fats, legumes, fish, and vegetables with lower processed foods.",
        deltas: {
          "nutrition.diet_quality_indicator": 16,
          "behaviors.diet_quality_indicator": 1,
          "labs.ldl": -9,
          "labs.hdl": 2,
        },
      }),
    );
  }

  if (signals.inactivity) {
    candidates.push(
      makeModifier({
        id: "resistance-plus-cardio-program",
        category: "positive_habits_non_medical",
        title: "Resistance + Cardio Progression Program",
        description: "Progressive combination training plan to improve insulin sensitivity and cardiometabolic fitness.",
        deltas: {
          "behaviors.pa_minutes_week": 210,
          "body.bmi": -1.4,
          "labs.hba1c": -0.3,
          "labs.hdl": 2,
        },
      }),
    );
  }

  if (canonical.behaviors.sleep_hours == null || canonical.behaviors.sleep_hours < 7) {
    candidates.push(
      makeModifier({
        id: "sleep-consistency-program",
        category: "breaking_negative_habits",
        title: "Sleep Consistency Program",
        description: "Consistent wake/sleep timing and light exposure interventions for restorative sleep.",
        deltas: {
          "behaviors.sleep_hours": 1.1,
          "vitals.resting_hr": -2,
          "vitals.sbp": -2,
        },
      }),
    );
  }

  candidates.push(
    makeModifier({
      id: "stress-recovery-blocks",
      category: "positive_habits_non_medical",
      title: "Daily Stress Recovery Blocks",
      description: "Planned parasympathetic recovery sessions to reduce chronic physiologic stress load.",
      deltas: {
        "vitals.sbp": -3,
        "vitals.resting_hr": -3,
        "behaviors.sleep_hours": 0.5,
      },
    }),
    makeModifier({
      id: "care-team-follow-up-program",
      category: "positive_habits_non_medical",
      title: "Quarterly Care-Team Follow-Up Program",
      description: "Regular multidisciplinary follow-up with target-based lifestyle accountability.",
      deltas: {
        "behaviors.pa_minutes_week": 90,
        "behaviors.diet_quality_indicator": 0.4,
        "vitals.sbp": -2,
      },
    }),
  );

  return candidates;
};

const profileSummary = (canonical: CanonicalUserInput) => {
  const signals = inferProfileSignals(canonical);
  const inferredConditions = Object.entries(signals)
    .filter(([, value]) => value)
    .map(([key]) => key);

  return {
    demographics: canonical.demographics,
    body: canonical.body,
    vitals: canonical.vitals,
    labs: canonical.labs,
    behaviors: canonical.behaviors,
    nutrition: {
      diet_quality_indicator: canonical.nutrition.diet_quality_indicator,
      sugary_drinks_per_week: canonical.nutrition.sugary_drinks_per_week,
      alcohol_drinks_per_day: canonical.nutrition.alcohol_drinks_per_day,
    },
    histories: canonical.histories,
    medications_text: canonical.medications_text,
    inferred_conditions: inferredConditions,
    condition_flags: signals,
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

const coerceModifier = (raw: unknown): ModifierDefinition | null => {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;

  const title = typeof row.title === "string" ? row.title.trim() : "";
  const description = typeof row.description === "string" ? row.description.trim() : "";
  const category = CATEGORY_ENUM.includes(row.category as ModifierCategory)
    ? (row.category as ModifierCategory)
    : null;

  if (!title || !description || !category) return null;

  const deltasRaw = row.deltas && typeof row.deltas === "object"
    ? (row.deltas as Record<string, unknown>)
    : {};

  const deltas: Record<string, number> = {};
  for (const [key, value] of Object.entries(deltasRaw)) {
    if (!(ALLOWED_DELTA_PATHS as readonly string[]).includes(key)) continue;
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) continue;
    deltas[key] = clamp(num, -500, 500);
  }

  if (Object.keys(deltas).length === 0) return null;

  return makeModifier({
    id: toId(typeof row.id === "string" ? row.id : title),
    category,
    title,
    description,
    enabledByDefault: false,
    deltas,
  });
};

const mergeUniqueModifiers = (...groups: ModifierDefinition[][]): ModifierDefinition[] => {
  const seen = new Set<string>();
  const out: ModifierDefinition[] = [];

  for (const modifier of groups.flat()) {
    const normalizedId = toId(modifier.id);
    if (seen.has(normalizedId)) continue;

    const clampedDeltas = Object.fromEntries(
      Object.entries(modifier.deltas)
        .filter(([key]) => (ALLOWED_DELTA_PATHS as readonly string[]).includes(key))
        .map(([key, value]) => [key, clamp(Number.isFinite(value) ? value : 0, -500, 500)]),
    );

    if (Object.keys(clampedDeltas).length === 0) continue;

    seen.add(normalizedId);
    out.push({
      ...modifier,
      id: normalizedId,
      deltas: clampedDeltas,
    });
  }

  return out;
};

const topUpWithDeterministicFallback = (
  canonical: CanonicalUserInput,
  existing: ModifierDefinition[],
): ModifierDefinition[] => {
  const signals = inferProfileSignals(canonical);
  const candidates = buildDeterministicFallbackModifiers(canonical, signals);
  const existingIds = new Set(existing.map((modifier) => toId(modifier.id)));
  const out: ModifierDefinition[] = [];

  for (const candidate of candidates) {
    const id = toId(candidate.id);
    if (existingIds.has(id)) continue;
    existingIds.add(id);
    out.push(candidate);
    if (existing.length + out.length >= MIN_TOTAL_MODIFIERS) break;
  }

  return out;
};

const generateWithOpenAI = async (
  canonical: CanonicalUserInput,
  existing: ModifierDefinition[],
  targetAdditionalCount = TARGET_OPENAI_ADDITIONAL,
): Promise<ModifierDefinition[]> => {
  if (!env.OPENAI_API_KEY) return [];

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const existingIds = existing.map((modifier) => modifier.id);
  const signals = inferProfileSignals(canonical);
  const activeSignals = Object.entries(signals)
    .filter(([, value]) => value)
    .map(([key]) => key);

  const minMedicationCount =
    signals.hypertension || signals.diabetes || signals.chronicKidneyDisease || signals.dyslipidemia
      ? 4
      : 2;
  const minBehaviorCount = 6;
  const lowerTarget = Math.max(10, targetAdditionalCount - 2);
  const upperTarget = Math.max(lowerTarget + 2, targetAdditionalCount + 4);

  const response = await client.responses.create({
    model: env.OPENAI_MODEL,
    temperature: 0.2,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Generate personalized health simulation modifiers. Return ONLY valid JSON. " +
              "Prioritize profile-specific relevance and avoid generic duplicates. " +
              "When hypertension/diabetes/CKD are present, include medication options tied to those conditions.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `Profile summary: ${JSON.stringify(profileSummary(canonical))}\n` +
              `Detected profile signals: ${JSON.stringify(activeSignals)}\n` +
              `Existing modifier IDs (do not duplicate): ${JSON.stringify(existingIds)}\n` +
              `Allowed categories: ${JSON.stringify(CATEGORY_ENUM)}\n` +
              `Allowed delta paths: ${JSON.stringify(ALLOWED_DELTA_PATHS)}\n` +
              `Return ${lowerTarget} to ${upperTarget} additional modifiers.\n` +
              `Include at least ${minMedicationCount} medication_prescribed options when conditions justify them.\n` +
              `Include at least ${minBehaviorCount} combined behavior options across breaking_negative_habits + positive_habits_non_medical.\n` +
              "Each modifier must include 2-5 clinically plausible deltas and should read like a concrete personalized intervention.",
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "modifier_generation",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["modifiers"],
          properties: {
            modifiers: {
              type: "array",
              minItems: 0,
              maxItems: 28,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "category", "title", "description", "deltas"],
                properties: {
                  id: { type: "string" },
                  category: { type: "string", enum: CATEGORY_ENUM },
                  title: { type: "string" },
                  description: { type: "string" },
                  deltas: {
                    type: "object",
                    additionalProperties: false,
                    properties: Object.fromEntries(
                      ALLOWED_DELTA_PATHS.map((pathKey) => [pathKey, { type: "number" }]),
                    ),
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const payload = JSON.parse(extractOpenAIOutputText(response)) as { modifiers?: unknown[] };
  const generated = (payload.modifiers ?? []).map(coerceModifier).filter((row): row is ModifierDefinition => !!row);

  return generated;
};

export const generateCandidateModifiers = async (
  canonical: CanonicalUserInput,
): Promise<ModifierDefinition[]> => {
  const generatedBase = baseModifiers(canonical);
  let generatedLLM: ModifierDefinition[] = [];

  try {
    generatedLLM = await generateWithOpenAI(canonical, generatedBase, TARGET_OPENAI_ADDITIONAL);

    const mergedAfterFirstPass = mergeUniqueModifiers(generatedBase, generatedLLM);
    if (mergedAfterFirstPass.length < MIN_TOTAL_MODIFIERS) {
      const secondPass = await generateWithOpenAI(
        canonical,
        mergedAfterFirstPass,
        TARGET_OPENAI_ADDITIONAL,
      );
      generatedLLM = mergeUniqueModifiers(generatedLLM, secondPass);
    }
  } catch (error) {
    console.error("[modifiers] OpenAI generation failed; continuing with deterministic personalized modifiers.", error);
  }

  const mergedWithoutTopUp = mergeUniqueModifiers(generatedBase, generatedLLM);
  const topUp =
    mergedWithoutTopUp.length >= MIN_TOTAL_MODIFIERS
      ? []
      : topUpWithDeterministicFallback(canonical, mergedWithoutTopUp);

  return mergeUniqueModifiers(mergedWithoutTopUp, topUp);
};

export const pickRecommendedModifierIds = (
  modifierDeltas: Array<{ modifier_id: string; unified_index_delta: number }>,
): string[] => {
  return modifierDeltas
    .filter((impact) => impact.unified_index_delta > 0.1)
    .sort((a, b) => b.unified_index_delta - a.unified_index_delta)
    .slice(0, 6)
    .map((impact) => impact.modifier_id);
};

