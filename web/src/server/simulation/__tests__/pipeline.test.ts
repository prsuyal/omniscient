import { describe, expect, it } from "vitest";

import { runSimulationPipeline } from "~/server/simulation/pipeline";
import { runScenarioComparisonWithCaching } from "~/server/simulation/scenarioRunner";
import { canonicalUserInputSchema, simulationCreateInputSchema } from "~/server/simulation/schemas";

describe("simulation schemas", () => {
  it("validates canonical shape", () => {
    const parsed = canonicalUserInputSchema.parse({
      demographics: { age: 45, sex: "Male", race_ethnicity: "Unknown", location: null, ses_pir: 2.3 },
      body: { height_cm: 178, weight_kg: 80, bmi: 25.2 },
      vitals: { sbp: 128, resting_hr: 72 },
      labs: { ldl: 130, hdl: 42, total_cholesterol: 210, hba1c: 5.8, egfr: 90 },
      histories: { family_history_text: null, personal_history_text: null, addiction_history_text: null },
      medications_text: null,
      behaviors: { sleep_hours: 7, alcohol_drinks_per_day: 1, pa_minutes_week: 120, diet_quality_indicator: 0.4 },
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
        alcohol_drinks_per_day: null,
        diet_quality_indicator: null,
        notes: null,
        warnings: [],
      },
      source_map: { "demographics.age": { source: "structured_form", confidence: 1 } },
      nutrition_source_map: {},
    });

    expect(parsed.demographics.age).toBe(45);
  });

  it("validates create input schema", () => {
    const parsed = simulationCreateInputSchema.parse({
      mode: "optionA",
      payload: {
        age: 51,
        sex: "Female",
        raceEthnicity: "Non-Hispanic Black",
        nutritionFreeform: "Mediterranean diet most days, avoid sugary drinks",
      },
      monteCarloSamples: 100,
    });

    expect(parsed.mode).toBe("optionA");
  });
});

describe("simulation pipeline", () => {
  it("returns baseline outputs quickly and computes modifier deltas on demand", async () => {
    const result = await runSimulationPipeline({
      mode: "optionA",
      payload: {
        age: 50,
        sex: "Male",
        raceEthnicity: "Non-Hispanic White",
        heightValue: 175,
        heightUnit: "cm",
        weightValue: 86,
        weightUnit: "kg",
        sbp: 134,
        restingHr: 77,
        ldl: 155,
        hdl: 39,
        totalCholesterol: 238,
        hba1c: 6.0,
        egfr: 92,
        sleepHours: 6,
        alcoholDrinksPerDay: 1,
        paMinutesWeek: 90,
        dietQualityIndicator: 55,
        nutritionFreeform: "Fast food 3x/week, soda daily, low vegetables",
      },
      endAge: 55,
      monteCarloSamples: 25,
    });

    expect(result.stage2.years.length).toBeGreaterThan(0);
    expect(result.stage2.diseases.length).toBeGreaterThan(0);
    expect(Object.keys(result.stage2.years[0]?.deterministic ?? {}).length).toBeGreaterThan(0);
    for (const disease of result.stage2.diseases) {
      let previous = 0;
      for (const year of result.stage2.years) {
        const current = year.deterministic[disease] ?? previous;
        expect(current).toBeGreaterThanOrEqual(previous - 1e-8);
        previous = current;
      }
    }

    expect(result.unifiedIndex.value).toBeGreaterThanOrEqual(0);
    expect(result.unifiedIndex.value).toBeLessThanOrEqual(100);

    expect(result.confidence.overall_confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence.overall_confidence).toBeLessThanOrEqual(100);

    expect(result.modifiers.length).toBeGreaterThan(0);
    expect(result.modifierImpacts.length).toBe(0);

    const firstModifier = result.modifiers[0];
    expect(firstModifier).toBeDefined();

    const comparison = await runScenarioComparisonWithCaching({
      canonicalInput: result.canonicalInput,
      baseline: {
        canonicalInput: result.canonicalInput,
        stage1: result.stage1,
        stage2: result.stage2,
        unifiedIndex: result.unifiedIndex,
        confidence: result.confidence,
        cacheKey: "baseline-test",
      },
      activeModifierIds: firstModifier ? [firstModifier.id] : [],
      modifiers: result.modifiers,
      config: {
        startAge: result.stage1.startAge,
        endAge: result.stage1.endAge,
        monteCarloSamples: 25,
      },
    });

    expect(comparison.comparison.stage2.years.length).toBeGreaterThan(0);
    const riskDeltas = Object.values(comparison.comparison.risk_delta_by_disease_at_horizon);
    const hasShift = riskDeltas.some((delta) => Math.abs(delta) > 1e-8);
    expect(hasShift || Math.abs(comparison.comparison.unified_index_delta) > 1e-8).toBe(true);
  }, 240_000);
});
