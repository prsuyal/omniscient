# CHANGELOG

## Stage 1 Biomarker Simulator Upgrade

- Added NHANES RXQ_RX ingestion and merged person-level indicators: `statin_use`, `lipid_lowering_use`.
- Implemented robust ingredient-name heuristics for lipid medications when full class lookup is unavailable.
- Added per-biomarker model-class table and specialized model families:
  - `crp`: log-scale OU (right-skew handling).
  - `ldl`, `hdl`, `total_cholesterol`: regime-switching medication-aware OU + correlated innovations.
  - `egfr`: bounded-logit OU with upper-bound model selection (120 vs 130).
- Extended validation with age-bin Wasserstein, KS, mean/std gaps, drift RMSE, and variance pass rate.

## Active Model Class Map
- `crp` -> `log_ou`
- `egfr` -> `bounded_logit_ou`
- `hdl` -> `lipid_regime`
- `ldl` -> `lipid_regime`
- `total_cholesterol` -> `lipid_regime`
