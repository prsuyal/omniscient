const requiredEnv: Record<string, string> = {
  NODE_ENV: "test",
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

for (const [key, value] of Object.entries(requiredEnv)) {
  if (!process.env[key]) {
    Object.assign(process.env, { [key]: value });
  }
}
