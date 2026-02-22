import { RISK_WEIGHT } from "~/data/mockMedicalData";
import type {
  ConflictWarning,
  EvidenceStrength,
  Intervention,
  InterventionInteraction,
  RiskCategory,
} from "~/types/medical";

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const lerp = (start: number, end: number, t: number) => start + (end - start) * t;

const hexToRgb = (hex: string) => {
  const cleaned = hex.replace("#", "");
  const bigint = Number.parseInt(cleaned, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
};

const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }) =>
  `#${[r, g, b]
    .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;

export const hexToRgba = (hex: string, alpha: number) => {
  const rgb = hexToRgb(hex);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;
};

const RISK_COLOR_STOPS = [
  { t: 0, color: "#57EBC0" },
  { t: 0.26, color: "#A1F27F" },
  { t: 0.52, color: "#F6CD62" },
  { t: 0.76, color: "#F18A4C" },
  { t: 1, color: "#D33552" },
] as const;

export const normalizedRiskToColor = (normalizedRisk: number) => {
  const t = clamp(normalizedRisk / 100, 0, 1);

  const upper =
    RISK_COLOR_STOPS.find((stop) => stop.t >= t) ??
    RISK_COLOR_STOPS[RISK_COLOR_STOPS.length - 1] ??
    RISK_COLOR_STOPS[0];
  const lower =
    [...RISK_COLOR_STOPS].reverse().find((stop) => stop.t <= t) ??
    RISK_COLOR_STOPS[0] ??
    RISK_COLOR_STOPS[RISK_COLOR_STOPS.length - 1];

  if (upper.t === lower.t) {
    return upper.color;
  }

  const localT = (t - lower.t) / (upper.t - lower.t);
  const lowRgb = hexToRgb(lower.color);
  const highRgb = hexToRgb(upper.color);

  return rgbToHex({
    r: lerp(lowRgb.r, highRgb.r, localT),
    g: lerp(lowRgb.g, highRgb.g, localT),
    b: lerp(lowRgb.b, highRgb.b, localT),
  });
};

export const interpolateByAge = (points: Array<{ age: number; value: number }>, targetAge: number) => {
  if (points.length === 0) {
    return 0;
  }

  if (targetAge <= points[0]!.age) {
    return points[0]!.value;
  }

  if (targetAge >= points[points.length - 1]!.age) {
    return points[points.length - 1]!.value;
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const current = points[i]!;
    const next = points[i + 1]!;

    if (targetAge >= current.age && targetAge <= next.age) {
      const span = next.age - current.age;
      const t = span === 0 ? 0 : (targetAge - current.age) / span;
      return lerp(current.value, next.value, t);
    }
  }

  return points[points.length - 1]!.value;
};

export const normalizeRiskValue = (category: RiskCategory, value: number) => {
  if (category === "healthcareCost") {
    // Map annual expected cost into a 0-100 risk-equivalent domain for visual unification.
    return clamp(((value - 1000) / (60000 - 1000)) * 100, 0, 100);
  }

  return clamp(value, 0, 100);
};

const evidenceStrengthWeight: Record<EvidenceStrength, number> = {
  strong: 1,
  moderate: 0.76,
  emerging: 0.58,
};

export const evidenceLabel: Record<EvidenceStrength, string> = {
  strong: "Strong evidence",
  moderate: "Moderate evidence",
  emerging: "Emerging evidence",
};

export const getEvidenceWeight = (evidence: EvidenceStrength) => evidenceStrengthWeight[evidence];

export const getAgeEffectFactor = (age: number, intervention: Intervention) => {
  const onset = intervention.onsetAge ?? 45;
  const distance = Math.abs(age - onset);
  const centered = 1 - distance / 90;
  return clamp(centered, 0.62, 1.08);
};

export const findConflicts = (
  activeInterventionIds: string[],
  interactions: InterventionInteraction[],
): ConflictWarning[] => {
  const activeSet = new Set(activeInterventionIds);

  return interactions
    .filter((interaction) => interaction.members.every((member) => activeSet.has(member)))
    .map((interaction) => ({
      interactionId: interaction.id,
      label: interaction.label,
      penalties: interaction.penalties,
      unifiedPenalty: interaction.unifiedPenalty,
    }));
};

export const applyInterventionEffects = ({
  category,
  age,
  baseline,
  activeInterventions,
  conflicts,
}: {
  category: RiskCategory;
  age: number;
  baseline: number;
  activeInterventions: Intervention[];
  conflicts: ConflictWarning[];
}) => {
  const effects = activeInterventions
    .map((intervention) => ({
      intervention,
      delta: intervention.effects[category] ?? 0,
    }))
    .filter((effect) => effect.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  let modified = baseline;

  effects.forEach((effect, index) => {
    const diminishingFactor = index === 0 ? 1 : clamp(1 - index * 0.18, 0.4, 1);
    const ageFactor = getAgeEffectFactor(age, effect.intervention);
    modified += effect.delta * diminishingFactor * ageFactor;
  });

  conflicts.forEach((conflict) => {
    modified += conflict.penalties[category] ?? 0;
  });

  if (category === "healthcareCost") {
    return clamp(modified, 200, 150000);
  }

  return clamp(modified, 0, 100);
};

export const formatRiskValue = (value: number, category: RiskCategory) => {
  if (category === "healthcareCost") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  }

  return `${Math.round(value)}%`;
};

export const formatDeltaValue = (delta: number, category: RiskCategory) => {
  if (category === "healthcareCost") {
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(Math.abs(delta));
    return `${delta <= 0 ? "-" : "+"}${formatted}`;
  }

  return `${delta <= 0 ? "-" : "+"}${Math.abs(delta).toFixed(1)} pts`;
};

export const computeUnifiedIndex = ({
  normalizedRiskByCategory,
  activeInterventions,
  conflicts,
  age,
}: {
  normalizedRiskByCategory: Record<RiskCategory, number>;
  activeInterventions: Intervention[];
  conflicts: ConflictWarning[];
  age: number;
}) => {
  const weightedRiskExposure = Object.entries(normalizedRiskByCategory).reduce(
    (acc, [category, normalizedRisk]) => {
      const key = category as RiskCategory;
      const weight = RISK_WEIGHT[key];
      return {
        weightedRisk: acc.weightedRisk + normalizedRisk * weight,
        totalWeight: acc.totalWeight + weight,
      };
    },
    { weightedRisk: 0, totalWeight: 0 },
  );

  const exposureScore =
    weightedRiskExposure.totalWeight === 0
      ? 0
      : weightedRiskExposure.weightedRisk / weightedRiskExposure.totalWeight;

  let index = 100 - exposureScore * 0.9;

  const interventionBonuses = [...activeInterventions]
    .map((intervention) => intervention.unifiedIndexDelta * getAgeEffectFactor(age, intervention))
    .sort((a, b) => Math.abs(b) - Math.abs(a));

  interventionBonuses.forEach((bonus, indexOrder) => {
    const overlapFactor = indexOrder === 0 ? 1 : clamp(1 - indexOrder * 0.2, 0.35, 1);
    index += bonus * overlapFactor;
  });

  conflicts.forEach((conflict) => {
    index -= conflict.unifiedPenalty;
  });

  return clamp(index, 1, 99);
};
