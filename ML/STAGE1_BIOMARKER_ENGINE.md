# Stage 1 Biomarker Simulation Engine

Implementation file: `stage1_biomarker_simulation.py`

## Implemented API

- `fit_conditional_mean(df, biomarker, config)`
- `estimate_variance(df, biomarker, mean_model, config)`
- `calibrate_kappa(df, biomarker, mean_model, variance_model, bounds, config)`
- `simulate_trajectory(process_model, profile, start_age, end_age, n_simulations, random_seed)`
- `validate_model(process_model, df, config, output_dir)`
- `simulate_biomarkers(process_models, profile, start_age, end_age, n_simulations, random_seed)`

## Modeling Notes

- Mean model `mu(age, Z)`:
  - weighted ridge regression
  - cubic age spline basis
  - static covariates (`sex`, `race_ethnicity`, `region_proxy`, and available static continuous covariates)
  - age-spline × sex interaction

- Drift term:
  - `alpha(age, Z) = mu(age + 1, Z) - mu(age, Z)`

- Variance model `sigma(age, Z)`:
  - weighted ridge on `log(residual^2)`
  - age-dependent heteroskedasticity via spline basis

- Mean reversion `kappa(age)`:
  - `kappa(age) = kappa0 + kappa_age * ((age - age_ref)/10)`
  - clipped to `(0, 2)` for stability
  - calibrated by minimizing age-wise simulated-vs-NHANES variance mismatch

- Boundary handling:
  - reflective boundary correction for each biomarker
  - corrections logged during simulation

## Validation Metrics

- Distribution recovery test: age-wise 1D Wasserstein distance
- Variance alignment test: age-wise relative variance error and pass-rate at 5%
- Drift accuracy test: RMSE between simulated age-mean and modeled `mu(age, Z)`

## CLI Usage

```bash
MPLCONFIGDIR=/path/to/writable MPLBACKEND=Agg \
./venv/bin/python stage1_biomarker_simulation.py \
  --data outputs/cleaned/nhanes_2011_2018_merged_cleaned.csv.gz \
  --out outputs/stage1_biomarker_simulation
```

Optional subset run:

```bash
./venv/bin/python stage1_biomarker_simulation.py \
  --biomarkers bmi systolic_bp
```

## Artifacts

- `stage1_biomarker_models.joblib` (serialized process model payload)
- `<biomarker>_kappa_calibration.csv`
- `<biomarker>_validation_by_age.csv`
- `diagnostics/<biomarker>_validation.png`
- `stage1_validation_summary.csv`
- `TECHNICAL_SUMMARY.md`
- `manifest.json`
