export const STAGE2_AUC_BY_DISEASE = {
  cardiovascular_disease: 0.82,
  chronic_kidney_disease: 0.8,
  liver_disease: 0.78,
  cancer_any: 0.74,
  mobility_limitation: 0.76,
  cognitive_decline: 0.79,
  arthritis: 0.73,
  hearing_loss: 0.75,
} as const;

export const DEFAULT_STAGE2_AUC = 0.72;

export const COMPLETENESS_FIELD_METADATA = {
  "demographics.age": {
    label: "Age",
    prompt: "Add age as an exact number in years.",
    relevant_diseases: ["all_models"],
  },
  "demographics.sex": {
    label: "Sex",
    prompt: "Add biological sex used by the model (Male/Female/Other/Unknown).",
    relevant_diseases: ["all_models"],
  },
  "body.bmi": {
    label: "BMI",
    prompt: "Add BMI directly, or provide both height and weight so BMI can be derived.",
    relevant_diseases: ["cardiovascular_disease", "liver_disease", "arthritis", "mobility_limitation"],
  },
  "vitals.sbp": {
    label: "Systolic blood pressure",
    prompt: "Add a recent systolic BP value (mmHg).",
    relevant_diseases: ["cardiovascular_disease", "chronic_kidney_disease", "cognitive_decline"],
  },
  "vitals.resting_hr": {
    label: "Resting heart rate",
    prompt: "Add resting heart rate (beats per minute).",
    relevant_diseases: ["cardiovascular_disease"],
  },
  "labs.ldl": {
    label: "LDL cholesterol",
    prompt: "Add LDL from your latest lipid panel (mg/dL).",
    relevant_diseases: ["cardiovascular_disease", "liver_disease"],
  },
  "labs.hdl": {
    label: "HDL cholesterol",
    prompt: "Add HDL from your latest lipid panel (mg/dL).",
    relevant_diseases: ["cardiovascular_disease"],
  },
  "labs.hba1c": {
    label: "HbA1c",
    prompt: "Add HbA1c from recent labs (%).",
    relevant_diseases: ["cardiovascular_disease", "chronic_kidney_disease", "cognitive_decline", "cancer_any"],
  },
  "labs.egfr": {
    label: "eGFR",
    prompt: "Add eGFR from kidney-function labs.",
    relevant_diseases: ["chronic_kidney_disease"],
  },
  "behaviors.sleep_hours": {
    label: "Sleep duration",
    prompt: "Add average sleep hours per night.",
    relevant_diseases: ["mobility_limitation", "cognitive_decline"],
  },
  "behaviors.pa_minutes_week": {
    label: "Weekly activity",
    prompt: "Add moderate/vigorous physical activity minutes per week.",
    relevant_diseases: ["mobility_limitation", "arthritis", "cardiovascular_disease"],
  },
  "behaviors.alcohol_drinks_per_day": {
    label: "Alcohol intake",
    prompt: "Add average alcoholic drinks per day.",
    relevant_diseases: ["liver_disease", "cardiovascular_disease"],
  },
  "nutrition.diet_quality_indicator": {
    label: "Diet quality",
    prompt: "Add dietary pattern details so diet quality can be estimated.",
    relevant_diseases: ["cardiovascular_disease", "cancer_any", "liver_disease"],
  },
  "nutrition.sugary_drinks_per_week": {
    label: "Sugary drinks frequency",
    prompt: "Add sugary drinks per week.",
    relevant_diseases: ["cardiovascular_disease", "liver_disease"],
  },
} as const;

export const COMPLETENESS_FIELDS = Object.keys(COMPLETENESS_FIELD_METADATA);

export type CompletenessFieldPath = keyof typeof COMPLETENESS_FIELD_METADATA;
