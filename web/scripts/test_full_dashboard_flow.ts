import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

const envDefaults: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "file:./dev.db",
  OPENAI_MODEL: "gpt-4.1-mini",
  PYTHON_BIN: "../ML/venv/bin/python",
  PYTHON_BRIDGE_PATH: "../ML/integration_bridge.py",
  STAGE1_MODEL_ARTIFACT: "../ML/outputs/stage1_biomarker_simulation_full/stage1_biomarker_models.joblib",
  STAGE1_METRICS_PATH: "../ML/outputs/stage1_biomarker_simulation_full/stage1_validation_summary.csv",
  STAGE2_MODEL_DIR: "../ML/outputs/models",
  UNCERTAINTY_A: "0.45",
  UNCERTAINTY_B: "0.35",
  UNCERTAINTY_C: "0.2",
  UNCERTAINTY_LAMBDA: "2",
  UNCERTAINTY_HORIZON: "sqrt",
  UPLOAD_DIR: "uploads",
  NEXT_PUBLIC_APP_NAME: "Medical Future Pipeline",
};

for (const [key, value] of Object.entries(envDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

const { runSimulationPipeline } = await import("../src/server/simulation/pipeline");
const { runScenarioComparisonWithCaching } = await import("../src/server/simulation/scenarioRunner");

const horizonRiskSnapshot = (stage2: { years: Array<{ age: number; deterministic: Record<string, number> }> }) => {
  const horizon = stage2.years[stage2.years.length - 1];
  return {
    age: horizon?.age ?? null,
    risks: horizon?.deterministic ?? {},
  };
};

const ensurePipelineOutputs = (result: Awaited<ReturnType<typeof runSimulationPipeline>>) => {
  assert(result.stage2.diseases.length > 0, "Stage2 diseases must exist");
  assert(result.stage2.years.length > 0, "Stage2 years must exist");
  for (const disease of result.stage2.diseases) {
    let previous = 0;
    for (const year of result.stage2.years) {
      const current = year.deterministic[disease] ?? previous;
      assert(current + 1e-8 >= previous, `Cumulative risk must be non-decreasing for ${disease}`);
      previous = current;
    }
  }
  assert(result.unifiedIndex.value >= 0 && result.unifiedIndex.value <= 100, "Unified index out of range");
  assert(
    result.confidence.overall_confidence >= 0 && result.confidence.overall_confidence <= 100,
    "Overall confidence out of range",
  );
  assert(result.modifiers.length > 0, "Modifiers were not generated");
};

const runOptionAFlow = async () => {
  const result = await runSimulationPipeline({
    mode: "optionA",
    payload: {
      age: 47,
      sex: "Male",
      raceEthnicity: "Non-Hispanic White",
      heightValue: 178,
      heightUnit: "cm",
      weightValue: 92,
      weightUnit: "kg",
      sbp: 136,
      restingHr: 80,
      ldl: 154,
      hdl: 40,
      totalCholesterol: 233,
      hba1c: 6.1,
      egfr: 95,
      sleepHours: 6.2,
      alcoholDrinksPerDay: 1.3,
      paMinutesWeek: 75,
      dietQualityIndicator: 50,
      nutritionFreeform: "I eat fast food 3x/week, lots of soda, low veggies, mostly chicken and rice",
      medications: "none",
      familyHistory: "Father had heart disease",
    },
    endAge: 62,
    monteCarloSamples: 25,
  });

  ensurePipelineOutputs(result);

  const baseline = {
    canonicalInput: result.canonicalInput,
    stage1: result.stage1,
    stage2: result.stage2,
    unifiedIndex: result.unifiedIndex,
    confidence: result.confidence,
    cacheKey: `baseline-${randomUUID()}`,
  };

  const impactful =
    result.modifierImpacts.find((impact) => impact.unified_index_delta !== 0)?.modifier_id ??
    result.modifiers[0]?.id;

  assert(impactful, "Expected at least one modifier id");

  const comparison = await runScenarioComparisonWithCaching({
    canonicalInput: result.canonicalInput,
    baseline,
    activeModifierIds: [impactful],
    modifiers: result.modifiers,
    config: {
      startAge: result.stage1.startAge,
      endAge: result.stage1.endAge,
      monteCarloSamples: 25,
    },
  });

  const deltaValues = Object.values(comparison.comparison.risk_delta_by_disease_at_horizon);
  const changed = deltaValues.some((value) => Math.abs(value) > 1e-8);

  assert(changed || Math.abs(comparison.comparison.unified_index_delta) > 1e-8, "Modifier toggle did not change outputs");

  return result;
};

const runOptionBFlow = async () => {
  const samplePdf = path.resolve(process.cwd(), "public/samples/sample-labs.pdf");
  let files: Array<{
    originalName: string;
    storedName: string;
    storedPath: string;
    mimeType: string;
    sizeBytes: number;
  }> = [];

  try {
    const fileStats = await stat(samplePdf);
    files = [
      {
        originalName: path.basename(samplePdf),
        storedName: path.basename(samplePdf),
        storedPath: samplePdf,
        mimeType: "application/pdf",
        sizeBytes: fileStats.size,
      },
    ];
  } catch {
    files = [];
  }

  const result = await runSimulationPipeline({
    mode: "optionB",
    payload: {
      freeformText:
        "52 year old woman. LDL 162, HDL 38, total cholesterol 244, SBP 148. Sleeps 5h. Minimal exercise.",
      nutritionFreeform: "Mediterranean diet most days, 2 servings fruit daily, avoid sugary drinks",
      files,
    },
    endAge: 67,
    monteCarloSamples: 25,
  });

  ensurePipelineOutputs(result);
  return result;
};

const optionAResult = await runOptionAFlow();
const optionBResult = await runOptionBFlow();

console.log("OptionA horizon:", horizonRiskSnapshot(optionAResult.stage2));
console.log("OptionB horizon:", horizonRiskSnapshot(optionBResult.stage2));
console.log("Full dashboard flow checks passed.");
