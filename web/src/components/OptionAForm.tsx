"use client";

import { useState } from "react";

import { NutritionFreeform } from "~/components/NutritionFreeform";

export type OptionAFormPayload = {
  age?: number | null;
  sex?: "Male" | "Female" | "Other" | "Unknown" | null;
  raceEthnicity?:
    | "Non-Hispanic White"
    | "Non-Hispanic Black"
    | "Mexican American"
    | "Other Hispanic"
    | "Non-Hispanic Asian"
    | "Other / Multiracial"
    | "Unknown"
    | null;
  heightValue?: number | null;
  heightUnit: "cm" | "in" | "ft";
  weightValue?: number | null;
  weightUnit: "kg" | "lb";
  location?: string | null;
  sesPirText?: string | null;
  familyHistory?: string | null;
  preExistingConditions?: string | null;
  medications?: string | null;
  nutritionFreeform?: string | null;
  sbp?: number | null;
  restingHr?: number | null;
  ldl?: number | null;
  hdl?: number | null;
  totalCholesterol?: number | null;
  hba1c?: number | null;
  egfr?: number | null;
  sleepHours?: number | null;
  alcoholDrinksPerDay?: number | null;
  paMinutesWeek?: number | null;
  dietQualityIndicator?: number | null;
};

export function OptionAForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting: boolean;
  onSubmit: (payload: OptionAFormPayload) => void;
}) {
  const [form, setForm] = useState({
    age: "",
    sex: "",
    raceEthnicity: "",
    heightValue: "",
    heightUnit: "cm" as "cm" | "in" | "ft",
    weightValue: "",
    weightUnit: "kg" as "kg" | "lb",
    location: "",
    sesPirText: "",
    familyHistory: "",
    preExistingConditions: "",
    medications: "",
    nutritionFreeform: "",
    sbp: "",
    restingHr: "",
    ldl: "",
    hdl: "",
    totalCholesterol: "",
    hba1c: "",
    egfr: "",
    sleepHours: "",
    alcoholDrinksPerDay: "",
    paMinutesWeek: "",
    dietQualityIndicator: "",
  });

  const toNullableNumber = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const toNullableString = (value: string): string | null => {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          age: toNullableNumber(form.age),
          sex: (form.sex || null) as OptionAFormPayload["sex"],
          raceEthnicity: (form.raceEthnicity || null) as OptionAFormPayload["raceEthnicity"],
          heightValue: toNullableNumber(form.heightValue),
          heightUnit: form.heightUnit,
          weightValue: toNullableNumber(form.weightValue),
          weightUnit: form.weightUnit,
          location: toNullableString(form.location),
          sesPirText: toNullableString(form.sesPirText),
          familyHistory: toNullableString(form.familyHistory),
          preExistingConditions: toNullableString(form.preExistingConditions),
          medications: toNullableString(form.medications),
          nutritionFreeform: toNullableString(form.nutritionFreeform),
          sbp: toNullableNumber(form.sbp),
          restingHr: toNullableNumber(form.restingHr),
          ldl: toNullableNumber(form.ldl),
          hdl: toNullableNumber(form.hdl),
          totalCholesterol: toNullableNumber(form.totalCholesterol),
          hba1c: toNullableNumber(form.hba1c),
          egfr: toNullableNumber(form.egfr),
          sleepHours: toNullableNumber(form.sleepHours),
          alcoholDrinksPerDay: toNullableNumber(form.alcoholDrinksPerDay),
          paMinutesWeek: toNullableNumber(form.paMinutesWeek),
          dietQualityIndicator: toNullableNumber(form.dietQualityIndicator),
        });
      }}
    >
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <label className="grid gap-1 text-sm">
          <span>Age</span>
          <input
            type="number"
            inputMode="numeric"
            value={form.age}
            onChange={(event) => setForm((prev) => ({ ...prev, age: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Sex</span>
          <select
            value={form.sex}
            onChange={(event) => setForm((prev) => ({ ...prev, sex: event.target.value }))}
            className="ui-input"
          >
            <option value="">Select</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Other">Other</option>
            <option value="Unknown">Unknown</option>
          </select>
        </label>

        <label className="grid gap-1 text-sm">
          <span>Race/Ethnicity</span>
          <select
            value={form.raceEthnicity}
            onChange={(event) => setForm((prev) => ({ ...prev, raceEthnicity: event.target.value }))}
            className="ui-input"
          >
            <option value="">Select</option>
            <option value="Non-Hispanic White">Non-Hispanic White</option>
            <option value="Non-Hispanic Black">Non-Hispanic Black</option>
            <option value="Mexican American">Mexican American</option>
            <option value="Other Hispanic">Other Hispanic</option>
            <option value="Non-Hispanic Asian">Non-Hispanic Asian</option>
            <option value="Other / Multiracial">Other / Multiracial</option>
            <option value="Unknown">Unknown</option>
          </select>
        </label>

        <label className="grid gap-1 text-sm">
          <span>Height</span>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              type="number"
              inputMode="decimal"
              value={form.heightValue}
              onChange={(event) => setForm((prev) => ({ ...prev, heightValue: event.target.value }))}
              className="ui-input"
            />
            <select
              value={form.heightUnit}
              onChange={(event) => setForm((prev) => ({ ...prev, heightUnit: event.target.value as "cm" | "in" | "ft" }))}
              className="ui-input"
            >
              <option value="cm">cm</option>
              <option value="in">in</option>
              <option value="ft">ft</option>
            </select>
          </div>
        </label>

        <label className="grid gap-1 text-sm">
          <span>Weight</span>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              type="number"
              inputMode="decimal"
              value={form.weightValue}
              onChange={(event) => setForm((prev) => ({ ...prev, weightValue: event.target.value }))}
              className="ui-input"
            />
            <select
              value={form.weightUnit}
              onChange={(event) => setForm((prev) => ({ ...prev, weightUnit: event.target.value as "kg" | "lb" }))}
              className="ui-input"
            >
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </div>
        </label>

        <label className="grid gap-1 text-sm">
          <span>Location</span>
          <input
            type="text"
            value={form.location}
            onChange={(event) => setForm((prev) => ({ ...prev, location: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Socioeconomic status / PIR</span>
          <input
            type="text"
            value={form.sesPirText}
            onChange={(event) => setForm((prev) => ({ ...prev, sesPirText: event.target.value }))}
            className="ui-input"
            placeholder="e.g. 2.1"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>SBP</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.sbp}
            onChange={(event) => setForm((prev) => ({ ...prev, sbp: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Resting HR</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.restingHr}
            onChange={(event) => setForm((prev) => ({ ...prev, restingHr: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>LDL</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.ldl}
            onChange={(event) => setForm((prev) => ({ ...prev, ldl: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>HDL</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.hdl}
            onChange={(event) => setForm((prev) => ({ ...prev, hdl: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Total Cholesterol</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.totalCholesterol}
            onChange={(event) => setForm((prev) => ({ ...prev, totalCholesterol: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>HbA1c</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.hba1c}
            onChange={(event) => setForm((prev) => ({ ...prev, hba1c: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>eGFR</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.egfr}
            onChange={(event) => setForm((prev) => ({ ...prev, egfr: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Sleep hours</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.sleepHours}
            onChange={(event) => setForm((prev) => ({ ...prev, sleepHours: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Alcohol drinks/day</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.alcoholDrinksPerDay}
            onChange={(event) => setForm((prev) => ({ ...prev, alcoholDrinksPerDay: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Physical activity minutes/week</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.paMinutesWeek}
            onChange={(event) => setForm((prev) => ({ ...prev, paMinutesWeek: event.target.value }))}
            className="ui-input"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Diet quality indicator</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.dietQualityIndicator}
            onChange={(event) => setForm((prev) => ({ ...prev, dietQualityIndicator: event.target.value }))}
            className="ui-input"
          />
        </label>
      </div>

      <label className="grid gap-1 text-sm">
        <span>Family history (optional)</span>
        <textarea
          value={form.familyHistory}
          onChange={(event) => setForm((prev) => ({ ...prev, familyHistory: event.target.value }))}
          className="ui-textarea min-h-20"
        />
      </label>

      <label className="grid gap-1 text-sm">
        <span>Pre-existing conditions (optional)</span>
        <textarea
          value={form.preExistingConditions}
          onChange={(event) => setForm((prev) => ({ ...prev, preExistingConditions: event.target.value }))}
          className="ui-textarea min-h-20"
        />
      </label>

      <label className="grid gap-1 text-sm">
        <span>Medications (optional)</span>
        <textarea
          value={form.medications}
          onChange={(event) => setForm((prev) => ({ ...prev, medications: event.target.value }))}
          className="ui-textarea min-h-20"
        />
      </label>

      <NutritionFreeform
        value={form.nutritionFreeform}
        onChange={(value) => setForm((prev) => ({ ...prev, nutritionFreeform: value }))}
      />

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isSubmitting}
          className="ui-btn ui-btn-primary"
        >
          {isSubmitting ? "Running..." : "Run Pipeline"}
        </button>
      </div>
    </form>
  );
}
