const DISEASE_LABELS: Record<string, string> = {
  cardiovascular_disease: "Cardiovascular Disease",
  chronic_kidney_disease: "Chronic Kidney Disease",
  liver_disease: "Liver Disease",
  cancer_any: "Any Cancer",
  mobility_limitation: "Mobility Limitation",
  cognitive_decline: "Cognitive Decline",
  arthritis: "Arthritis",
  hearing_loss: "Hearing Loss",
};

const toTitleCase = (value: string): string => {
  return value
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
};

export const formatDiseaseLabel = (diseaseId: string): string => {
  const mapped = DISEASE_LABELS[diseaseId];
  if (mapped) return mapped;

  return toTitleCase(diseaseId.replaceAll("_", " "));
};

