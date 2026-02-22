import { describe, expect, it } from "vitest";

import { generateCandidateModifiers } from "~/server/simulation/modifiers";
import { canonicalUserInputSchema } from "~/server/simulation/schemas";

describe("modifier generation", () => {
  it("returns a broad personalized intervention set for cardiometabolic profiles", async () => {
    const canonical = canonicalUserInputSchema.parse({
      demographics: {
        age: 56,
        sex: "Male",
        race_ethnicity: "Non-Hispanic White",
        location: null,
        ses_pir: 2.1,
      },
      body: {
        height_cm: 176,
        weight_kg: 104,
        bmi: 33.6,
      },
      vitals: {
        sbp: 149,
        resting_hr: 84,
      },
      labs: {
        ldl: 168,
        hdl: 37,
        total_cholesterol: 252,
        hba1c: 7.2,
        egfr: 58,
      },
      histories: {
        family_history_text: "Family history of heart disease and diabetes",
        personal_history_text: "Primary hypertension and type 2 diabetes",
        addiction_history_text: null,
      },
      medications_text: "None currently",
      behaviors: {
        sleep_hours: 5.8,
        alcohol_drinks_per_day: 1.7,
        pa_minutes_week: 45,
        diet_quality_indicator: -1.2,
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
        sugary_drinks_per_week: 7,
        alcohol_drinks_per_day: 1.7,
        diet_quality_indicator: 44,
        notes: null,
        warnings: [],
      },
      source_map: {},
      nutrition_source_map: {},
    });

    const modifiers = await generateCandidateModifiers(canonical);
    const medicationCount = modifiers.filter((modifier) => modifier.category === "medication_prescribed").length;

    expect(modifiers.length).toBeGreaterThanOrEqual(12);
    expect(medicationCount).toBeGreaterThanOrEqual(4);
    expect(
      modifiers.some((modifier) =>
        /(blood pressure|hypertension|ace\/arb|thiazide)/i.test(
          `${modifier.title} ${modifier.description}`,
        ),
      ),
    ).toBe(true);
    expect(
      modifiers.some((modifier) =>
        /(glucose|diabetes|metformin|sglt2|glp-1|hba1c)/i.test(
          `${modifier.title} ${modifier.description}`,
        ),
      ),
    ).toBe(true);
  });
});

