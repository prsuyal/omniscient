import { describe, expect, it } from "vitest";

import { computeUnifiedHealthIndex } from "~/server/simulation/unifiedIndex";
import type { CanonicalUserInput, Stage1Output, Stage2Output } from "~/server/simulation/schemas";

const makeCanonical = (overrides: Partial<CanonicalUserInput>): CanonicalUserInput => {
  const base: CanonicalUserInput = {
    demographics: {
      age: 50,
      sex: "Male",
      race_ethnicity: "Unknown",
      location: null,
      ses_pir: 2.0,
    },
    body: {
      height_cm: 175,
      weight_kg: 80,
      bmi: 26,
    },
    vitals: {
      sbp: 130,
      resting_hr: 72,
    },
    labs: {
      ldl: 120,
      hdl: 45,
      total_cholesterol: 210,
      hba1c: 5.8,
      egfr: 92,
    },
    histories: {
      family_history_text: null,
      personal_history_text: null,
      addiction_history_text: null,
    },
    medications_text: null,
    behaviors: {
      sleep_hours: 7,
      alcohol_drinks_per_day: 0,
      pa_minutes_week: 180,
      diet_quality_indicator: 1,
    },
    nutrition: {
      daily_calories_est: null,
      protein_g_est: null,
      fiber_g_est: null,
      added_sugar_g_est: null,
      saturated_fat_g_est: null,
      sodium_mg_est: null,
      fruit_veg_servings_per_day: null,
      ultra_processed_freq_per_week: null,
      sugary_drinks_per_week: null,
      alcohol_drinks_per_day: 0,
      diet_quality_indicator: 70,
      notes: null,
      warnings: [],
    },
    source_map: {},
    nutrition_source_map: {},
  };

  return {
    ...base,
    ...overrides,
    demographics: { ...base.demographics, ...(overrides.demographics ?? {}) },
    body: { ...base.body, ...(overrides.body ?? {}) },
    vitals: { ...base.vitals, ...(overrides.vitals ?? {}) },
    labs: { ...base.labs, ...(overrides.labs ?? {}) },
    histories: { ...base.histories, ...(overrides.histories ?? {}) },
    behaviors: { ...base.behaviors, ...(overrides.behaviors ?? {}) },
    nutrition: { ...base.nutrition, ...(overrides.nutrition ?? {}) },
    source_map: { ...base.source_map, ...(overrides.source_map ?? {}) },
    nutrition_source_map: {
      ...base.nutrition_source_map,
      ...(overrides.nutrition_source_map ?? {}),
    },
  };
};

const makeStage1 = (biomarkers: Record<string, number>): Stage1Output => ({
  startAge: 50,
  endAge: 70,
  trajectory: [
    {
      age: 70,
      biomarkers: Object.fromEntries(
        Object.entries(biomarkers).map(([name, mean]) => [
          name,
          {
            mean,
            p05: mean,
            p50: mean,
            p95: mean,
            base_sigma: 0.1,
            sigma_total: 0.1,
          },
        ]),
      ),
    },
  ],
  metricScoreByBiomarker: {},
});

const makeStage2 = (riskLevel: number): Stage2Output => ({
  diseases: ["cardiovascular_disease", "chronic_kidney_disease"],
  years: [
    {
      age: 50,
      deterministic: {
        cardiovascular_disease: riskLevel,
        chronic_kidney_disease: riskLevel,
      },
      uncertainty: {
        cardiovascular_disease: { mean: riskLevel, median: riskLevel, p05: riskLevel, p95: riskLevel },
        chronic_kidney_disease: { mean: riskLevel, median: riskLevel, p05: riskLevel, p95: riskLevel },
      },
    },
    {
      age: 70,
      deterministic: {
        cardiovascular_disease: riskLevel,
        chronic_kidney_disease: riskLevel,
      },
      uncertainty: {
        cardiovascular_disease: { mean: riskLevel, median: riskLevel, p05: riskLevel, p95: riskLevel },
        chronic_kidney_disease: { mean: riskLevel, median: riskLevel, p05: riskLevel, p95: riskLevel },
      },
    },
  ],
});

describe("computeUnifiedHealthIndex", () => {
  it("normalizes from conceptual worst to best range", () => {
    const best = computeUnifiedHealthIndex({
      canonicalInput: makeCanonical({
        behaviors: {
          sleep_hours: 7.5,
          alcohol_drinks_per_day: 0,
          pa_minutes_week: 300,
          diet_quality_indicator: 4,
        },
        nutrition: {
          daily_calories_est: null,
          protein_g_est: null,
          fiber_g_est: null,
          added_sugar_g_est: null,
          saturated_fat_g_est: null,
          sodium_mg_est: null,
          fruit_veg_servings_per_day: 6,
          ultra_processed_freq_per_week: 0,
          sugary_drinks_per_week: 0,
          alcohol_drinks_per_day: 0,
          diet_quality_indicator: 90,
          notes: null,
          warnings: [],
        },
      }),
      stage1: makeStage1({
        systolic_bp: 110,
        hba1c: 5,
        ldl: 70,
        hdl: 65,
        bmi: 22,
        egfr: 100,
      }),
      stage2: makeStage2(0.05),
    });

    const worst = computeUnifiedHealthIndex({
      canonicalInput: makeCanonical({
        behaviors: {
          sleep_hours: 3.5,
          alcohol_drinks_per_day: 6,
          pa_minutes_week: 0,
          diet_quality_indicator: -4,
        },
        nutrition: {
          daily_calories_est: null,
          protein_g_est: null,
          fiber_g_est: null,
          added_sugar_g_est: null,
          saturated_fat_g_est: null,
          sodium_mg_est: null,
          fruit_veg_servings_per_day: 0,
          ultra_processed_freq_per_week: 14,
          sugary_drinks_per_week: 14,
          alcohol_drinks_per_day: 6,
          diet_quality_indicator: 20,
          notes: null,
          warnings: [],
        },
      }),
      stage1: makeStage1({
        systolic_bp: 180,
        hba1c: 10,
        ldl: 220,
        hdl: 25,
        bmi: 45,
        egfr: 20,
      }),
      stage2: makeStage2(0.75),
    });

    expect(best.value).toBeGreaterThan(90);
    expect(worst.value).toBeLessThan(15);
    expect(best.value).toBeGreaterThan(worst.value);
  });
});
