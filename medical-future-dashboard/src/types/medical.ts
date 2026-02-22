export type RiskCategory =
  | "arthritis"
  | "mobility"
  | "workingMemory"
  | "cardiovascular"
  | "kidney"
  | "liver"
  | "auditoryLoss"
  | "healthcareCost";

export type InterventionCategory =
  | "breaking habits"
  | "non-medical improvements"
  | "medications"
  | "surgical treatments";

export type EvidenceStrength = "strong" | "moderate" | "emerging";

export type ValueUnit = "percent" | "usd";

export interface AgePoint {
  age: number;
  value: number;
}

export interface FeatureImpact {
  feature: string;
  impact: number;
}

export interface RiskForecast {
  id: RiskCategory;
  label: string;
  shortLabel: string;
  bodyLabel: string;
  unit: ValueUnit;
  confidence: number;
  explanation: string;
  baselineByAge: AgePoint[];
  featureImportance: FeatureImpact[];
}

export interface Intervention {
  id: string;
  title: string;
  category: InterventionCategory;
  evidence: EvidenceStrength;
  summary: string;
  effects: Partial<Record<RiskCategory, number>>;
  unifiedIndexDelta: number;
  onsetAge?: number;
  incompatibleWith?: string[];
}

export interface InterventionInteraction {
  id: string;
  members: [string, string];
  label: string;
  penalties: Partial<Record<RiskCategory, number>>;
  unifiedPenalty: number;
}

export interface SeriesPoint {
  age: number;
  baseline: number;
  modified: number;
  normalizedBaseline: number;
  normalizedModified: number;
}

export interface RiskSnapshot {
  baseline: number;
  modified: number;
  delta: number;
  normalizedBaseline: number;
  normalizedModified: number;
}

export interface PreventableRiskInsight {
  category: RiskCategory;
  label: string;
  preventedAmount: number;
  preventedNormalized: number;
  unit: ValueUnit;
}

export interface InterventionImpactScore {
  interventionId: string;
  title: string;
  category: InterventionCategory;
  score: number;
  evidence: EvidenceStrength;
}

export interface ConflictWarning {
  interactionId: string;
  label: string;
  penalties: Partial<Record<RiskCategory, number>>;
  unifiedPenalty: number;
}
