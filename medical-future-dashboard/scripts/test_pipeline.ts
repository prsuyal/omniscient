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
    Object.assign(process.env, { [key]: value });
  }
}

const { runSimulationPipeline } = await import("../src/server/simulation/pipeline");

const summarizeRun = (
  stage2: {
    years: Array<{
      age: number;
      deterministic: Record<string, number>;
    }>;
  },
) => {
  const years = stage2.years ?? [];
  if (!years.length) return { summary: "No stage2 years found" };

  const startAge = years[0]?.age ?? 0;
  const targetAge = startAge + 10;
  let closest = years[0]!;
  for (const year of years) {
    if (Math.abs(year.age - targetAge) < Math.abs(closest.age - targetAge)) {
      closest = year;
    }
  }

  return {
    targetAge,
    actualAge: closest.age,
    risks: closest.deterministic,
  };
};

const run = async () => {
  const optionARunId = randomUUID();
  const optionAResult = await runSimulationPipeline({
    mode: "optionA",
    payload: {
      age: 46,
      sex: "Male",
      raceEthnicity: "Non-Hispanic White",
      heightValue: 178,
      heightUnit: "cm",
      weightValue: 88,
      weightUnit: "kg",
      location: "Austin, TX",
      sesPirText: "2.7",
      familyHistory: "Father had heart disease in his 50s",
      preExistingConditions: "Borderline hypertension",
      medications: "None",
      sbp: 132,
      restingHr: 78,
      ldl: 145,
      hdl: 41,
      totalCholesterol: 225,
      hba1c: 5.8,
      egfr: 96,
      sleepHours: 6.5,
      alcoholDrinksPerDay: 1.0,
      paMinutesWeek: 80,
      dietQualityIndicator: 0.2,
    },
    endAge: 66,
    monteCarloSamples: 40,
  });

  console.log("[OptionA] runId=", optionARunId, summarizeRun(optionAResult.stage2));

  try {
    const optionBTextRunId = randomUUID();
    const optionBTextResult = await runSimulationPipeline({
      mode: "optionB",
      payload: {
        freeformText:
          "I am a 52 year old woman. Recent lab: LDL 162, HDL 38, total cholesterol 244, SBP 148. Sleep ~5 hours. Minimal exercise.",
        files: [],
      },
      endAge: 72,
      monteCarloSamples: 40,
    });

    console.log("[OptionB-text] runId=", optionBTextRunId, summarizeRun(optionBTextResult.stage2));
  } catch (error) {
    console.error("[OptionB-text] failed", error);
  }

  const defaultSamplePdf = path.resolve(process.cwd(), "public/samples/sample-labs.pdf");
  const pdfPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultSamplePdf;

  try {
    const fileStats = await stat(pdfPath);
    const optionBPdfRunId = randomUUID();
    const optionBPdfResult = await runSimulationPipeline({
      mode: "optionB",
      payload: {
        freeformText: "Please parse attached PDF for bloodwork and profile.",
        files: [
          {
            originalName: path.basename(pdfPath),
            storedName: path.basename(pdfPath),
            storedPath: pdfPath,
            mimeType: "application/pdf",
            sizeBytes: fileStats.size,
          },
        ],
      },
      startAge: 45,
      endAge: 65,
      monteCarloSamples: 40,
    });

    console.log("[OptionB-pdf] runId=", optionBPdfRunId, summarizeRun(optionBPdfResult.stage2));
  } catch (error) {
    console.error("[OptionB-pdf] failed", error);
  }
};

run().catch((error) => {
  console.error("test_pipeline failed", error);
  process.exitCode = 1;
});
