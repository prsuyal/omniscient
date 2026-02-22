import type {
  Intervention,
  InterventionCategory,
  InterventionInteraction,
  RiskCategory,
  RiskForecast,
} from "~/types/medical";

export const AGE_MIN = 25;
export const AGE_MAX = 85;
export const AGE_DEFAULT = 42;

export const AGE_ANCHORS = Array.from(
  { length: (AGE_MAX - AGE_MIN) / 5 + 1 },
  (_, index) => AGE_MIN + index * 5,
);

export const AGE_RANGE = Array.from(
  { length: AGE_MAX - AGE_MIN + 1 },
  (_, index) => AGE_MIN + index,
);

export const RISK_ORDER: RiskCategory[] = [
  "cardiovascular",
  "mobility",
  "arthritis",
  "workingMemory",
  "kidney",
  "liver",
  "auditoryLoss",
  "healthcareCost",
];

export const RISK_WEIGHT: Record<RiskCategory, number> = {
  arthritis: 1.08,
  mobility: 1.26,
  workingMemory: 1.18,
  cardiovascular: 1.42,
  kidney: 1.2,
  liver: 1.12,
  auditoryLoss: 0.86,
  healthcareCost: 1.06,
};

export const INTERVENTION_CATEGORIES: Array<
  InterventionCategory | "all"
> = [
  "all",
  "breaking habits",
  "non-medical improvements",
  "medications",
  "surgical treatments",
];

const percentTrajectory = (values: number[]) =>
  AGE_ANCHORS.map((age, index) => ({ age, value: values[index] ?? values.at(-1) ?? 0 }));

const costTrajectory = (values: number[]) =>
  AGE_ANCHORS.map((age, index) => ({ age, value: values[index] ?? values.at(-1) ?? 0 }));

// Mock payload that simulates backend model outputs.
export const riskForecasts: RiskForecast[] = [
  {
    id: "arthritis",
    label: "Arthritis Progression Risk",
    shortLabel: "Arthritis",
    bodyLabel: "Joint network",
    unit: "percent",
    confidence: 0.84,
    explanation:
      "Progressive inflammatory markers, BMI trend, and prior injury history strongly increase future joint degeneration probability.",
    baselineByAge: percentTrajectory([12, 15, 19, 24, 30, 37, 45, 53, 62, 70, 76, 82, 87]),
    featureImportance: [
      { feature: "Prior knee trauma", impact: 0.28 },
      { feature: "Body mass trend", impact: 0.24 },
      { feature: "CRP trajectory", impact: 0.18 },
      { feature: "Strength training adherence", impact: -0.16 },
      { feature: "Omega-3 intake", impact: -0.09 },
    ],
  },
  {
    id: "mobility",
    label: "Mobility Decline Risk",
    shortLabel: "Mobility",
    bodyLabel: "Lower body axis",
    unit: "percent",
    confidence: 0.8,
    explanation:
      "Gait speed and lower-body power patterns indicate elevated odds of age-related movement limitation without intervention.",
    baselineByAge: percentTrajectory([8, 9, 11, 14, 18, 24, 31, 39, 48, 58, 68, 76, 84]),
    featureImportance: [
      { feature: "Gait velocity", impact: 0.31 },
      { feature: "Quad strength asymmetry", impact: 0.21 },
      { feature: "Sedentary time", impact: 0.16 },
      { feature: "Daily step consistency", impact: -0.18 },
      { feature: "Resistance training", impact: -0.14 },
    ],
  },
  {
    id: "workingMemory",
    label: "Working Memory Decline Risk",
    shortLabel: "Working Memory",
    bodyLabel: "Prefrontal cortex",
    unit: "percent",
    confidence: 0.77,
    explanation:
      "Sleep fragmentation, hearing burden, and cardiovascular strain combine to increase projected executive-function decline.",
    baselineByAge: percentTrajectory([10, 11, 13, 16, 21, 27, 34, 42, 52, 61, 70, 78, 85]),
    featureImportance: [
      { feature: "Sleep fragmentation index", impact: 0.29 },
      { feature: "Untreated auditory deficit", impact: 0.22 },
      { feature: "Pulse pressure", impact: 0.15 },
      { feature: "Cognitive drill adherence", impact: -0.2 },
      { feature: "Social engagement score", impact: -0.11 },
    ],
  },
  {
    id: "cardiovascular",
    label: "Cardiovascular Event Risk",
    shortLabel: "Cardiovascular",
    bodyLabel: "Cardiac core",
    unit: "percent",
    confidence: 0.9,
    explanation:
      "Lipid panel drift, systolic pressure load, and smoking exposure dominate long-range major-event risk.",
    baselineByAge: percentTrajectory([6, 8, 12, 17, 24, 33, 43, 54, 64, 73, 80, 86, 91]),
    featureImportance: [
      { feature: "LDL pattern", impact: 0.34 },
      { feature: "Systolic BP burden", impact: 0.27 },
      { feature: "Smoking pack-years", impact: 0.2 },
      { feature: "Cardio minutes/week", impact: -0.17 },
      { feature: "Fiber intake", impact: -0.08 },
    ],
  },
  {
    id: "kidney",
    label: "Kidney Health Risk",
    shortLabel: "Kidney",
    bodyLabel: "Renal system",
    unit: "percent",
    confidence: 0.74,
    explanation:
      "Renal function trajectory and chronic blood pressure load indicate moderate-to-high CKD progression potential in later decades.",
    baselineByAge: percentTrajectory([5, 6, 8, 11, 15, 20, 27, 35, 44, 52, 60, 67, 74]),
    featureImportance: [
      { feature: "eGFR slope", impact: 0.32 },
      { feature: "Hypertension duration", impact: 0.24 },
      { feature: "NSAID exposure", impact: 0.17 },
      { feature: "Hydration consistency", impact: -0.15 },
      { feature: "Sodium control", impact: -0.11 },
    ],
  },
  {
    id: "liver",
    label: "Liver Health Risk",
    shortLabel: "Liver",
    bodyLabel: "Hepatic region",
    unit: "percent",
    confidence: 0.7,
    explanation:
      "Metabolic syndrome burden and medication profile indicate gradual increase in hepatic stress probability.",
    baselineByAge: percentTrajectory([7, 8, 10, 13, 17, 22, 28, 34, 41, 49, 57, 64, 71]),
    featureImportance: [
      { feature: "ALT/AST trend", impact: 0.27 },
      { feature: "Alcohol exposure", impact: 0.24 },
      { feature: "Triglyceride profile", impact: 0.19 },
      { feature: "Weight reduction", impact: -0.18 },
      { feature: "Mediterranean compliance", impact: -0.12 },
    ],
  },
  {
    id: "auditoryLoss",
    label: "Auditory Loss Risk",
    shortLabel: "Auditory Loss",
    bodyLabel: "Auditory channels",
    unit: "percent",
    confidence: 0.76,
    explanation:
      "High-frequency threshold loss and prolonged noise exposure indicate increasing probability of disabling hearing loss.",
    baselineByAge: percentTrajectory([9, 10, 12, 15, 19, 24, 30, 37, 45, 54, 63, 72, 80]),
    featureImportance: [
      { feature: "HF audiometry slope", impact: 0.31 },
      { feature: "Chronic noise exposure", impact: 0.23 },
      { feature: "Cardiometabolic strain", impact: 0.15 },
      { feature: "Hearing aid usage", impact: -0.2 },
      { feature: "Smoking cessation", impact: -0.08 },
    ],
  },
  {
    id: "healthcareCost",
    label: "Expected Healthcare Financial Cost",
    shortLabel: "Healthcare Cost",
    bodyLabel: "Financial impact",
    unit: "usd",
    confidence: 0.68,
    explanation:
      "Projected healthcare utilization, comorbidity stacking, and intervention burden estimate annual cost accumulation.",
    baselineByAge: costTrajectory([
      1200, 1800, 2400, 3400, 4800, 6800, 9600, 13200, 17600, 23000, 29500, 37200, 46000,
    ]),
    featureImportance: [
      { feature: "Comorbidity count", impact: 0.33 },
      { feature: "Hospitalization history", impact: 0.22 },
      { feature: "Medication complexity", impact: 0.18 },
      { feature: "Preventive adherence", impact: -0.2 },
      { feature: "Activity consistency", impact: -0.13 },
    ],
  },
];

// Mock payload that simulates backend intervention recommendation output.
export const interventions: Intervention[] = [
  {
    id: "smoking-cessation",
    title: "Structured Smoking Cessation",
    category: "breaking habits",
    evidence: "strong",
    summary:
      "12-month cessation program with coaching + pharmacologic support to reduce cardiometabolic burden.",
    effects: {
      cardiovascular: -9,
      kidney: -5,
      liver: -6,
      mobility: -3,
      workingMemory: -2,
      auditoryLoss: -2,
      healthcareCost: -3800,
    },
    unifiedIndexDelta: 4,
    onsetAge: 34,
  },
  {
    id: "anti-inflammatory-diet",
    title: "Anti-inflammatory Nutrition Plan",
    category: "non-medical improvements",
    evidence: "strong",
    summary:
      "Mediterranean-forward protocol with sodium guardrails and protein timing.",
    effects: {
      arthritis: -8,
      cardiovascular: -4,
      liver: -3,
      kidney: -2,
      mobility: -3,
      healthcareCost: -1500,
    },
    unifiedIndexDelta: 3,
    onsetAge: 33,
  },
  {
    id: "strength-balance",
    title: "Progressive Strength + Balance",
    category: "non-medical improvements",
    evidence: "strong",
    summary:
      "Supervised lower-body power + balance cycle 3x/week with gait reassessment every quarter.",
    effects: {
      mobility: -11,
      arthritis: -6,
      cardiovascular: -3,
      workingMemory: -2,
      healthcareCost: -1200,
    },
    unifiedIndexDelta: 3,
    onsetAge: 38,
  },
  {
    id: "sleep-cognitive-protocol",
    title: "Sleep + Cognitive Protocol",
    category: "non-medical improvements",
    evidence: "moderate",
    summary:
      "Sleep consolidation, blue-light control, and targeted working-memory drills.",
    effects: {
      workingMemory: -10,
      cardiovascular: -2,
      mobility: -2,
      auditoryLoss: -1,
      healthcareCost: -900,
    },
    unifiedIndexDelta: 3,
    onsetAge: 36,
  },
  {
    id: "statin-therapy",
    title: "High-Intensity Statin Therapy",
    category: "medications",
    evidence: "strong",
    summary:
      "Aggressive LDL control and plaque-stability benefit with routine hepatic monitoring.",
    effects: {
      cardiovascular: -12,
      kidney: -2,
      workingMemory: -1,
      liver: 4,
      healthcareCost: -600,
    },
    unifiedIndexDelta: 2,
    onsetAge: 45,
    incompatibleWith: ["nsaid-long-term"],
  },
  {
    id: "nsaid-long-term",
    title: "Long-term NSAID Regimen",
    category: "medications",
    evidence: "moderate",
    summary:
      "Chronic anti-inflammatory strategy for pain control with known renal/hepatic tradeoffs.",
    effects: {
      arthritis: -7,
      mobility: -4,
      kidney: 6,
      liver: 3,
      healthcareCost: 800,
    },
    unifiedIndexDelta: -1,
    onsetAge: 40,
    incompatibleWith: ["renal-protective-protocol", "statin-therapy"],
  },
  {
    id: "renal-protective-protocol",
    title: "Renal Protective Protocol",
    category: "medications",
    evidence: "strong",
    summary:
      "ACE/ARB optimization and nephro-protective monitoring pathway.",
    effects: {
      kidney: -10,
      cardiovascular: -4,
      liver: -1,
      healthcareCost: -2200,
    },
    unifiedIndexDelta: 3,
    onsetAge: 44,
    incompatibleWith: ["nsaid-long-term"],
  },
  {
    id: "hearing-rehab",
    title: "Hearing Aid + Auditory Rehab",
    category: "non-medical improvements",
    evidence: "moderate",
    summary:
      "Modern hearing aid fitting with structured auditory retraining and speech-in-noise follow-up.",
    effects: {
      auditoryLoss: -14,
      workingMemory: -4,
      healthcareCost: -700,
    },
    unifiedIndexDelta: 2,
    onsetAge: 48,
  },
  {
    id: "bariatric-surgery",
    title: "Metabolic Bariatric Surgery",
    category: "surgical treatments",
    evidence: "strong",
    summary:
      "Weight-loss surgery pathway with multidisciplinary follow-up and risk-factor re-baselining.",
    effects: {
      mobility: -13,
      cardiovascular: -10,
      kidney: -6,
      liver: -8,
      arthritis: -5,
      workingMemory: -2,
      healthcareCost: -5000,
    },
    unifiedIndexDelta: 6,
    onsetAge: 43,
    incompatibleWith: ["joint-replacement"],
  },
  {
    id: "joint-replacement",
    title: "Joint Replacement Pathway",
    category: "surgical treatments",
    evidence: "strong",
    summary:
      "Primary joint replacement with structured post-op rehabilitation and load management.",
    effects: {
      arthritis: -15,
      mobility: -9,
      cardiovascular: 2,
      healthcareCost: 2500,
    },
    unifiedIndexDelta: 1,
    onsetAge: 56,
    incompatibleWith: ["bariatric-surgery"],
  },
];

// Mock backend interaction matrix for known intervention conflicts.
export const interventionInteractions: InterventionInteraction[] = [
  {
    id: "renal-nsaid-conflict",
    members: ["renal-protective-protocol", "nsaid-long-term"],
    label: "Renal-protective protocol is partially negated by chronic NSAID exposure.",
    penalties: {
      kidney: 8,
      healthcareCost: 1200,
      mobility: 1,
    },
    unifiedPenalty: 3,
  },
  {
    id: "dual-surgery-load",
    members: ["bariatric-surgery", "joint-replacement"],
    label: "Concurrent major-surgery recovery load raises short-term event and cost burden.",
    penalties: {
      cardiovascular: 3,
      mobility: 4,
      healthcareCost: 3000,
    },
    unifiedPenalty: 4,
  },
  {
    id: "liver-strain-combo",
    members: ["statin-therapy", "nsaid-long-term"],
    label: "Combined medication load increases hepatic and renal strain in this simulation.",
    penalties: {
      liver: 5,
      kidney: 2,
      healthcareCost: 500,
    },
    unifiedPenalty: 2,
  },
];
