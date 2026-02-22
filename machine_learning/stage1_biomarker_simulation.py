"""Stage 1 biomarker simulation engine.

Upgraded Stage 1 model classes for underperforming biomarkers:
- CRP: log-scale mean-reverting Gaussian Markov model.
- LDL/HDL/Total cholesterol: medication-aware regime-switching Gaussian Markov.
- eGFR: bounded-logit transform Gaussian Markov with upper-bound selection.

The public simulation API is preserved. ``simulate_biomarkers`` supports both:
1) legacy call style: simulate_biomarkers(process_models, profile, start_age, end_age, ...)
2) stage-1 style:     simulate_biomarkers(profile, start_age, end_age, ..., process_models=...)
"""

from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping

import joblib
import matplotlib
import numpy as np
import pandas as pd
from scipy.stats import ks_2samp
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import SplineTransformer

matplotlib.use("Agg")
import matplotlib.pyplot as plt


BIOMARKERS: tuple[str, ...] = (
    "bmi",
    "systolic_bp",
    "diastolic_bp",
    "resting_hr",
    "ldl",
    "hdl",
    "total_cholesterol",
    "hba1c",
    "egfr",
    "crp",
    "height_cm",
    "pir",
    "sleep_hours",
    "diet_quality_indicator",
    "alcohol_drinks_per_day",
    "pa_minutes_week",
)

LIPID_BIOMARKERS: tuple[str, ...] = ("ldl", "hdl", "total_cholesterol")

MODEL_CLASS_BY_BIOMARKER: dict[str, str] = {
    "crp": "log_ou",
    "egfr": "bounded_logit_ou",
    "ldl": "lipid_regime",
    "hdl": "lipid_regime",
    "total_cholesterol": "lipid_regime",
}

DEFAULT_BOUNDS: dict[str, tuple[float, float]] = {
    "bmi": (10.0, 80.0),
    "systolic_bp": (70.0, 250.0),
    "diastolic_bp": (35.0, 150.0),
    "resting_hr": (30.0, 220.0),
    "ldl": (0.0, 300.0),
    "hdl": (5.0, 160.0),
    "total_cholesterol": (60.0, 450.0),
    "hba1c": (3.0, 15.0),
    "egfr": (0.0, 130.0),
    "crp": (0.0, 80.0),
    "height_cm": (120.0, 230.0),
    "pir": (0.0, 5.0),
    "sleep_hours": (2.0, 16.0),
    "diet_quality_indicator": (0.0, 1.0),
    "alcohol_drinks_per_day": (0.0, 20.0),
    "pa_minutes_week": (0.0, 4000.0),
}

CYCLE_SUFFIX_BY_LABEL: dict[str, str] = {
    "2011-2012": "G",
    "2013-2014": "H",
    "2015-2016": "I",
    "2017-2018": "J",
}

# Ingredient-name based heuristics used when full Multum lookup is not available.
STATIN_PATTERNS: tuple[str, ...] = (
    "ATORVASTATIN",
    "SIMVASTATIN",
    "ROSUVASTATIN",
    "PRAVASTATIN",
    "LOVASTATIN",
    "FLUVASTATIN",
    "PITAVASTATIN",
    "CERIVASTATIN",
)

LIPID_LOWERING_PATTERNS: tuple[str, ...] = (
    *STATIN_PATTERNS,
    "EZETIMIBE",
    "FENOFIBRATE",
    "GEMFIBROZIL",
    "COLESEVELAM",
    "COLESTIPOL",
    "CHOLESTYRAMINE",
    "BEMPEDOIC",
    "ALIROCUMAB",
    "EVOLOCUMAB",
    "NIACIN",
)


@dataclass(slots=True)
class SimulationConfig:
    age_column: str = "age"
    weight_column: str = "sample_weight"

    static_categorical_covariates: tuple[str, ...] = (
        "sex",
        "race_ethnicity",
        "region_proxy",
    )
    static_continuous_covariates: tuple[str, ...] = (
        "pir",
        "height_cm",
        "bmi",
        "creatinine",
        "statin_use",
        "lipid_lowering_use",
    )

    mean_spline_knots: int = 6
    variance_spline_knots: int = 5

    mean_ridge_alpha: float = 1.0
    variance_ridge_alpha: float = 2.0

    interaction_dummy: str = "sex__Male"

    kappa_floor: float = 0.02
    kappa_ceiling: float = 1.95

    kappa0_search_bounds: tuple[float, float] = (0.05, 1.6)
    kappa_age_search_bounds: tuple[float, float] = (-0.45, 0.45)
    kappa_grid_k0: int = 26
    kappa_grid_kage: int = 13
    kappa_refinement_rounds: int = 3

    calibration_particles_per_age: int = 550
    calibration_min_age_count: int = 70

    validation_particles_per_age: int = 900
    validation_min_age_count: int = 70

    # Age-bin diagnostics: 20-24, 25-29, ... , 80+
    age_bin_width: int = 5
    age_bin_min: int = 20
    age_bin_top_start: int = 80

    variance_floor_quantile: float = 0.05
    epsilon: float = 1e-8

    # Metric weights for scalar score.
    score_wasserstein: float = 0.45
    score_mean_rmse: float = 0.25
    score_drift_rmse: float = 0.2
    score_variance_penalty: float = 0.1

    min_regime_obs: int = 250

    random_seed: int = 42


@dataclass(slots=True)
class DesignMatrixState:
    age_column: str
    age_median: float
    spline_transformer: SplineTransformer
    spline_feature_names: list[str]

    continuous_covariates: list[str]
    continuous_medians: dict[str, float]
    continuous_means: dict[str, float]
    continuous_stds: dict[str, float]

    categorical_covariates: list[str]
    categorical_levels: dict[str, list[str]]

    interaction_dummy: str | None
    interaction_feature_names: list[str]

    feature_names: list[str]


@dataclass(slots=True)
class ConditionalMeanModel:
    biomarker: str
    state: DesignMatrixState
    coefficients: np.ndarray
    ridge_alpha: float
    n_obs: int
    weighted_rmse: float

    def predict(self, covariates: pd.DataFrame) -> np.ndarray:
        X = _build_design_matrix(covariates, self.state, fit=False)
        return X @ self.coefficients


@dataclass(slots=True)
class VarianceModel:
    biomarker: str
    state: DesignMatrixState
    coefficients: np.ndarray
    ridge_alpha: float
    variance_floor: float
    n_obs: int

    def predict_sigma(self, covariates: pd.DataFrame) -> np.ndarray:
        X = _build_design_matrix(covariates, self.state, fit=False)
        log_var = X @ self.coefficients
        var = np.exp(log_var) + self.variance_floor
        return np.sqrt(np.maximum(var, self.variance_floor))


@dataclass(slots=True)
class KappaCalibrationResult:
    biomarker: str
    kappa0: float
    kappa_age: float
    age_reference: float
    kappa_floor: float
    kappa_ceiling: float
    objective_value: float
    calibration_table: pd.DataFrame

    def kappa(self, ages: np.ndarray) -> np.ndarray:
        scaled_age = (np.asarray(ages, dtype=float) - self.age_reference) / 10.0
        raw = self.kappa0 + self.kappa_age * scaled_age
        return np.clip(raw, self.kappa_floor, self.kappa_ceiling)


@dataclass(slots=True)
class RegimeEmissionModel:
    mean_model: ConditionalMeanModel
    variance_model: VarianceModel
    kappa_result: KappaCalibrationResult
    n_obs: int


@dataclass(slots=True)
class TransitionDesignState:
    numeric_features: list[str]
    numeric_means: dict[str, float]
    numeric_stds: dict[str, float]
    categorical_features: list[str]
    categorical_levels: dict[str, list[str]]
    feature_names: list[str]


@dataclass(slots=True)
class TransitionModel:
    state: TransitionDesignState
    coefficients: np.ndarray
    intercept: float
    persistence_coef: float

    def logit_base(self, covariates: pd.DataFrame) -> np.ndarray:
        X = _build_transition_matrix(covariates, self.state, fit=False)
        return self.intercept + X @ self.coefficients

    def probability(self, covariates: pd.DataFrame, previous_regime: np.ndarray) -> np.ndarray:
        logit = self.logit_base(covariates) + self.persistence_coef * np.asarray(previous_regime, dtype=float)
        return 1.0 / (1.0 + np.exp(-np.clip(logit, -20.0, 20.0)))


@dataclass(slots=True)
class BiomarkerProcessModel:
    biomarker: str
    model_class: str
    bounds: tuple[float, float]
    mean_model: ConditionalMeanModel | None = None
    variance_model: VarianceModel | None = None
    kappa_result: KappaCalibrationResult | None = None
    transform_params: dict[str, float] | None = None
    regimes: dict[str, RegimeEmissionModel] | None = None
    transition_model: TransitionModel | None = None
    regime_corr: dict[str, np.ndarray] | None = None
    lipid_order: tuple[str, ...] | None = None
    mean_model_rmse: float = np.nan
    n_obs: int = 0


@dataclass(slots=True)
class ValidationResult:
    biomarker: str
    per_age: pd.DataFrame
    mean_wasserstein: float
    variance_pass_rate: float
    drift_rmse: float
    mean_model_rmse: float
    ks_mean: float
    overall_score: float


def _safe_float(value: Any, fallback: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return fallback
    if not np.isfinite(out):
        return fallback
    return out


def _normalize_weights(weights: np.ndarray, epsilon: float = 1e-12) -> np.ndarray:
    w = np.asarray(weights, dtype=float).copy()
    w[~np.isfinite(w)] = 0.0
    w = np.clip(w, 0.0, None)
    s = w.sum()
    if s <= epsilon:
        if len(w) == 0:
            return w
        return np.full(len(w), 1.0 / len(w), dtype=float)
    return w / s


def weighted_mean(values: np.ndarray, weights: np.ndarray) -> float:
    x = np.asarray(values, dtype=float)
    w = _normalize_weights(np.asarray(weights, dtype=float))
    if len(x) == 0:
        return np.nan
    return float(np.sum(x * w))


def weighted_variance(values: np.ndarray, weights: np.ndarray) -> float:
    x = np.asarray(values, dtype=float)
    w = _normalize_weights(np.asarray(weights, dtype=float))
    if len(x) == 0:
        return np.nan
    m = np.sum(x * w)
    return float(np.sum(w * (x - m) ** 2))


def _weighted_sample_indices(
    n_rows: int,
    n_samples: int,
    weights: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
    probs = _normalize_weights(np.asarray(weights, dtype=float))
    return rng.choice(n_rows, size=n_samples, replace=True, p=probs)


def weighted_wasserstein_distance(
    x: np.ndarray,
    y: np.ndarray,
    wx: np.ndarray | None = None,
    wy: np.ndarray | None = None,
) -> float:
    x_arr = np.asarray(x, dtype=float)
    y_arr = np.asarray(y, dtype=float)
    if x_arr.size == 0 or y_arr.size == 0:
        return np.nan

    wx_arr = np.ones_like(x_arr) if wx is None else np.asarray(wx, dtype=float)
    wy_arr = np.ones_like(y_arr) if wy is None else np.asarray(wy, dtype=float)

    wx_arr = _normalize_weights(wx_arr)
    wy_arr = _normalize_weights(wy_arr)

    x_order = np.argsort(x_arr)
    y_order = np.argsort(y_arr)

    x_sorted = x_arr[x_order]
    y_sorted = y_arr[y_order]
    wx_sorted = wx_arr[x_order]
    wy_sorted = wy_arr[y_order]

    x_cdf = np.cumsum(wx_sorted)
    y_cdf = np.cumsum(wy_sorted)

    support = np.unique(np.concatenate([x_sorted, y_sorted]))
    if support.size <= 1:
        return 0.0

    x_idx = np.searchsorted(x_sorted, support, side="right") - 1
    y_idx = np.searchsorted(y_sorted, support, side="right") - 1

    x_eval = np.where(x_idx >= 0, x_cdf[np.clip(x_idx, 0, len(x_cdf) - 1)], 0.0)
    y_eval = np.where(y_idx >= 0, y_cdf[np.clip(y_idx, 0, len(y_cdf) - 1)], 0.0)

    deltas = np.diff(support)
    cdf_gap = np.abs(x_eval[:-1] - y_eval[:-1])
    return float(np.sum(cdf_gap * deltas))


def apply_reflective_bounds(values: np.ndarray, lower: float, upper: float) -> tuple[np.ndarray, np.ndarray]:
    reflected = np.asarray(values, dtype=float).copy()
    correction_count = np.zeros(reflected.shape, dtype=int)

    for _ in range(12):
        below = reflected < lower
        above = reflected > upper
        if not below.any() and not above.any():
            break
        if below.any():
            reflected[below] = lower + (lower - reflected[below])
            correction_count[below] += 1
        if above.any():
            reflected[above] = upper - (reflected[above] - upper)
            correction_count[above] += 1

    still = (reflected < lower) | (reflected > upper)
    if still.any():
        reflected = np.clip(reflected, lower, upper)
        correction_count[still] += 1

    return reflected, correction_count


def _fit_weighted_ridge(X: np.ndarray, y: np.ndarray, weights: np.ndarray, alpha: float) -> np.ndarray:
    sqrt_w = np.sqrt(np.clip(np.asarray(weights, dtype=float), 0.0, None))
    Xw = X * sqrt_w[:, None]
    yw = y * sqrt_w

    penalty = np.eye(X.shape[1], dtype=float)
    penalty[0, 0] = 0.0

    lhs = Xw.T @ Xw + alpha * penalty
    rhs = Xw.T @ yw
    return np.linalg.solve(lhs, rhs)


def _prepare_design_inputs(
    df: pd.DataFrame,
    *,
    age_column: str,
    continuous_covariates: list[str],
    categorical_covariates: list[str],
    fit: bool,
    existing_state: DesignMatrixState | None,
    interaction_dummy: str | None,
    spline_knots: int,
) -> tuple[pd.DataFrame, DesignMatrixState]:
    work = df.copy()

    if fit:
        age_numeric = pd.to_numeric(work[age_column], errors="coerce")
        age_median = _safe_float(age_numeric.median(skipna=True), 50.0)

        spline_transformer = SplineTransformer(
            n_knots=spline_knots,
            degree=3,
            include_bias=False,
            extrapolation="linear",
        )

        age_filled = age_numeric.fillna(age_median).to_numpy().reshape(-1, 1)
        spline_values = spline_transformer.fit_transform(age_filled)
        spline_feature_names = [f"age_spline_{i}" for i in range(spline_values.shape[1])]

        cont_medians: dict[str, float] = {}
        cont_means: dict[str, float] = {}
        cont_stds: dict[str, float] = {}
        for col in continuous_covariates:
            ser = pd.to_numeric(work[col], errors="coerce") if col in work.columns else pd.Series(np.nan, index=work.index)
            med = _safe_float(ser.median(skipna=True), 0.0)
            filled = ser.fillna(med)
            std = _safe_float(filled.std(ddof=0), 1.0)
            cont_medians[col] = med
            cont_means[col] = _safe_float(filled.mean(), 0.0)
            cont_stds[col] = std if std > 0 else 1.0

        cat_levels: dict[str, list[str]] = {}
        for col in categorical_covariates:
            ser = work[col] if col in work.columns else pd.Series("Unknown", index=work.index)
            levels = sorted(ser.fillna("Unknown").astype(str).unique().tolist())
            cat_levels[col] = levels if levels else ["Unknown"]

        state = DesignMatrixState(
            age_column=age_column,
            age_median=age_median,
            spline_transformer=spline_transformer,
            spline_feature_names=spline_feature_names,
            continuous_covariates=continuous_covariates,
            continuous_medians=cont_medians,
            continuous_means=cont_means,
            continuous_stds=cont_stds,
            categorical_covariates=categorical_covariates,
            categorical_levels=cat_levels,
            interaction_dummy=interaction_dummy,
            interaction_feature_names=[],
            feature_names=[],
        )
    else:
        if existing_state is None:
            raise ValueError("existing_state must be provided when fit=False")
        state = existing_state

    return work, state


def _build_design_matrix(df: pd.DataFrame, state: DesignMatrixState, *, fit: bool) -> np.ndarray:
    age_num = pd.to_numeric(df[state.age_column], errors="coerce")
    age_filled = age_num.fillna(state.age_median).to_numpy().reshape(-1, 1)
    spline_values = state.spline_transformer.transform(age_filled)

    cont_parts: list[np.ndarray] = []
    for col in state.continuous_covariates:
        ser = pd.to_numeric(df[col], errors="coerce") if col in df.columns else pd.Series(np.nan, index=df.index)
        filled = ser.fillna(state.continuous_medians[col]).to_numpy()
        scaled = (filled - state.continuous_means[col]) / state.continuous_stds[col]
        cont_parts.append(scaled.reshape(-1, 1))

    cat_parts: list[np.ndarray] = []
    cat_feature_names: list[str] = []
    for col in state.categorical_covariates:
        ser = df[col].fillna("Unknown").astype(str) if col in df.columns else pd.Series("Unknown", index=df.index)
        levels = state.categorical_levels[col]
        for level in levels:
            cat_parts.append((ser == level).to_numpy(dtype=float).reshape(-1, 1))
            cat_feature_names.append(f"{col}__{level}")

    design_parts: list[np.ndarray] = [np.ones((len(df), 1), dtype=float), spline_values]
    design_parts.extend(cont_parts)
    design_parts.extend(cat_parts)

    interaction_feature_names: list[str] = []
    if state.interaction_dummy is not None and state.interaction_dummy in cat_feature_names:
        idx = cat_feature_names.index(state.interaction_dummy)
        dummy_col = cat_parts[idx]
        for i, spline_name in enumerate(state.spline_feature_names):
            inter_col = spline_values[:, [i]] * dummy_col
            design_parts.append(inter_col)
            interaction_feature_names.append(f"{spline_name}_x_{state.interaction_dummy}")

    X = np.concatenate(design_parts, axis=1)

    if fit:
        feature_names = ["intercept", *state.spline_feature_names]
        feature_names.extend(state.continuous_covariates)
        feature_names.extend(cat_feature_names)
        feature_names.extend(interaction_feature_names)
        state.feature_names = feature_names
        state.interaction_feature_names = interaction_feature_names

    return X


def _assemble_covariate_columns(
    df: pd.DataFrame,
    target: str,
    config: SimulationConfig,
    *,
    extra_cont_covars: list[str] | None = None,
    extra_cat_covars: list[str] | None = None,
) -> tuple[list[str], list[str]]:
    cont = [c for c in config.static_continuous_covariates if c in df.columns and c != target]
    cat = [c for c in config.static_categorical_covariates if c in df.columns and c != target]

    if extra_cont_covars:
        for c in extra_cont_covars:
            if c in df.columns and c != target and c not in cont:
                cont.append(c)
    if extra_cat_covars:
        for c in extra_cat_covars:
            if c in df.columns and c != target and c not in cat:
                cat.append(c)

    return cont, cat


def _decode_obj_series(ser: pd.Series) -> pd.Series:
    if ser.dtype != object:
        return ser

    def _dec(v: Any) -> Any:
        if isinstance(v, bytes):
            return v.decode("latin1", errors="ignore")
        return v

    return ser.map(_dec)


def _decode_rx_df(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for col in out.columns:
        if out[col].dtype == object:
            out[col] = _decode_obj_series(out[col])
    return out


def _compile_keyword_regex(words: tuple[str, ...]) -> re.Pattern[str]:
    escaped = [re.escape(w) for w in words]
    return re.compile("|".join(escaped), flags=re.IGNORECASE)


def _load_rx_cycle_file(path: Path, cycle_label: str) -> pd.DataFrame:
    rx = pd.read_sas(path)
    rx = _decode_rx_df(rx)
    rx.columns = [c.upper() for c in rx.columns]
    rx["cycle_label"] = cycle_label

    for col in ["SEQN", "RXDUSE", "RXDCOUNT"]:
        if col in rx.columns:
            rx[col] = pd.to_numeric(rx[col], errors="coerce")

    for col in ["RXDDRUG", "RXDDRGID", "RXDRSD1", "RXDRSD2", "RXDRSD3", "RXDRSC1", "RXDRSC2", "RXDRSC3"]:
        if col in rx.columns:
            rx[col] = rx[col].fillna("").astype(str).str.strip().str.upper()
        else:
            rx[col] = ""

    return rx


def _derive_medication_indicators(rx: pd.DataFrame) -> pd.DataFrame:
    statin_re = _compile_keyword_regex(STATIN_PATTERNS)
    lipid_re = _compile_keyword_regex(LIPID_LOWERING_PATTERNS)

    rx_work = rx.copy()

    # Best-effort ID map from rows with recognized ingredient names.
    id_to_statin: dict[str, int] = {}
    id_to_lipid: dict[str, int] = {}
    for _, row in rx_work.iterrows():
        drug = str(row.get("RXDDRUG", ""))
        drug_id = str(row.get("RXDDRGID", "")).strip().lower()
        if not drug_id:
            continue
        if statin_re.search(drug):
            id_to_statin[drug_id] = 1
            id_to_lipid[drug_id] = 1
        elif lipid_re.search(drug):
            id_to_lipid[drug_id] = 1

    text_block = (
        rx_work["RXDDRUG"].astype(str)
        + " "
        + rx_work["RXDRSD1"].astype(str)
        + " "
        + rx_work["RXDRSD2"].astype(str)
        + " "
        + rx_work["RXDRSD3"].astype(str)
    )

    statin_name = text_block.str.contains(statin_re, na=False)
    lipid_name = text_block.str.contains(lipid_re, na=False)
    lipid_diag = text_block.str.contains("HYPERCHOLESTER|CHOLESTEROL|HYPERLIPID", regex=True, na=False)

    drug_ids = rx_work["RXDDRGID"].astype(str).str.strip().str.lower()
    statin_id = drug_ids.map(lambda x: id_to_statin.get(x, 0)).astype(bool)
    lipid_id = drug_ids.map(lambda x: id_to_lipid.get(x, 0)).astype(bool)

    rx_work["statin_use_row"] = (statin_name | statin_id).astype(int)
    rx_work["lipid_lowering_use_row"] = (lipid_name | lipid_id | statin_name | lipid_diag).astype(int)

    grouped = (
        rx_work.groupby(["cycle_label", "SEQN"], as_index=False)[["statin_use_row", "lipid_lowering_use_row"]]
        .max()
        .rename(columns={"statin_use_row": "statin_use", "lipid_lowering_use_row": "lipid_lowering_use"})
    )
    return grouped


def _add_rx_indicators(
    df: pd.DataFrame,
    raw_data_root: Path,
) -> pd.DataFrame:
    base = df.copy()

    if "cycle_label" not in base.columns or "seqn" not in base.columns:
        base["statin_use"] = pd.to_numeric(base.get("statin_use", 0.0), errors="coerce").fillna(0.0)
        base["lipid_lowering_use"] = pd.to_numeric(base.get("lipid_lowering_use", 0.0), errors="coerce").fillna(0.0)
        return base

    base["seqn"] = pd.to_numeric(base["seqn"], errors="coerce")
    base["cycle_label"] = base["cycle_label"].astype(str)

    rx_frames: list[pd.DataFrame] = []
    for cycle_label, suf in CYCLE_SUFFIX_BY_LABEL.items():
        path = raw_data_root / cycle_label / f"RXQ_RX_{suf}.xpt"
        if not path.exists():
            continue
        try:
            rx_cycle = _load_rx_cycle_file(path, cycle_label)
            rx_frames.append(_derive_medication_indicators(rx_cycle))
        except Exception:
            continue

    if not rx_frames:
        med = pd.to_numeric(base.get("medication_use", 0.0), errors="coerce").fillna(0.0)
        base["statin_use"] = (med > 0).astype(float)
        base["lipid_lowering_use"] = (med > 0).astype(float)
        return base

    rx_ind = pd.concat(rx_frames, ignore_index=True)
    rx_ind["SEQN"] = pd.to_numeric(rx_ind["SEQN"], errors="coerce")

    merged = base.merge(
        rx_ind,
        how="left",
        left_on=["cycle_label", "seqn"],
        right_on=["cycle_label", "SEQN"],
    )

    if "SEQN" in merged.columns:
        merged = merged.drop(columns=["SEQN"])

    merged["statin_use"] = pd.to_numeric(merged.get("statin_use", 0.0), errors="coerce").fillna(0.0)
    merged["lipid_lowering_use"] = pd.to_numeric(merged.get("lipid_lowering_use", 0.0), errors="coerce").fillna(0.0)

    # If no RX row for a person, treat as not using lipid meds.
    merged["statin_use"] = (merged["statin_use"] > 0).astype(float)
    merged["lipid_lowering_use"] = (merged["lipid_lowering_use"] > 0).astype(float)

    return merged


def _age_bin_label(age: float, config: SimulationConfig) -> str:
    a = int(math.floor(age))
    if a >= config.age_bin_top_start:
        return f"{config.age_bin_top_start}+"
    lo = max(config.age_bin_min, (a // config.age_bin_width) * config.age_bin_width)
    hi = lo + config.age_bin_width - 1
    return f"{lo}-{hi}"


def _marker_model_class(biomarker: str) -> str:
    return MODEL_CLASS_BY_BIOMARKER.get(biomarker, "gaussian_ou")


def _transform_values(
    values: np.ndarray,
    model_class: str,
    transform_params: Mapping[str, float] | None,
    epsilon: float = 1e-8,
) -> np.ndarray:
    x = np.asarray(values, dtype=float)
    if model_class == "log_ou":
        return np.log1p(np.clip(x, 0.0, None))

    if model_class == "bounded_logit_ou":
        if transform_params is None:
            raise ValueError("transform_params required for bounded_logit_ou")
        lower = float(transform_params.get("lower", 0.0))
        upper = float(transform_params.get("upper", 130.0))
        eps = float(transform_params.get("eps", epsilon))
        clipped = np.clip(x, lower + eps, upper - eps)
        return np.log((clipped - lower + eps) / (upper - clipped + eps))

    return x


def _inverse_transform_values(
    values: np.ndarray,
    model_class: str,
    transform_params: Mapping[str, float] | None,
    epsilon: float = 1e-8,
) -> np.ndarray:
    y = np.asarray(values, dtype=float)

    if model_class == "log_ou":
        out = np.expm1(y)
        return np.clip(out, 0.0, None)

    if model_class == "bounded_logit_ou":
        if transform_params is None:
            raise ValueError("transform_params required for bounded_logit_ou")
        lower = float(transform_params.get("lower", 0.0))
        upper = float(transform_params.get("upper", 130.0))
        eps = float(transform_params.get("eps", epsilon))
        p = 1.0 / (1.0 + np.exp(-np.clip(y, -25.0, 25.0)))
        out = lower + (upper - lower) * p
        return np.clip(out, lower + eps, upper - eps)

    return y


def _predict_mu_for_age(mean_model: ConditionalMeanModel, base_profiles: pd.DataFrame, age: float, age_col: str) -> np.ndarray:
    frame = base_profiles.copy()
    frame[age_col] = age
    return mean_model.predict(frame)


def _predict_sigma_for_age(
    variance_model: VarianceModel,
    base_profiles: pd.DataFrame,
    age: float,
    age_col: str,
) -> np.ndarray:
    frame = base_profiles.copy()
    frame[age_col] = age
    return variance_model.predict_sigma(frame)


def _kappa_from_params(
    ages: np.ndarray,
    kappa0: float,
    kappa_age: float,
    age_reference: float,
    config: SimulationConfig,
) -> np.ndarray:
    scaled_age = (np.asarray(ages, dtype=float) - age_reference) / 10.0
    kappa = kappa0 + kappa_age * scaled_age
    return np.clip(kappa, config.kappa_floor, config.kappa_ceiling)


def fit_conditional_mean(
    df: pd.DataFrame,
    biomarker: str,
    config: SimulationConfig,
    *,
    target_series: pd.Series | None = None,
    extra_cont_covars: list[str] | None = None,
    extra_cat_covars: list[str] | None = None,
) -> ConditionalMeanModel:
    """Fit weighted conditional mean E[target | age, Z] with age splines and covariates."""

    age_col = config.age_column
    weight_col = config.weight_column

    if biomarker not in df.columns:
        raise KeyError(f"Biomarker column '{biomarker}' not found")

    cont_covars, cat_covars = _assemble_covariate_columns(
        df,
        biomarker,
        config,
        extra_cont_covars=extra_cont_covars,
        extra_cat_covars=extra_cat_covars,
    )

    target_name = "__target__"
    model_df = df[[biomarker, age_col, weight_col, *cont_covars, *cat_covars]].copy()
    model_df[target_name] = pd.to_numeric(target_series, errors="coerce") if target_series is not None else pd.to_numeric(model_df[biomarker], errors="coerce")
    model_df = model_df[pd.to_numeric(model_df[weight_col], errors="coerce").fillna(0.0) > 0].copy()
    model_df[age_col] = pd.to_numeric(model_df[age_col], errors="coerce")
    model_df = model_df.dropna(subset=[target_name, age_col]).copy()

    work, state = _prepare_design_inputs(
        model_df,
        age_column=age_col,
        continuous_covariates=cont_covars,
        categorical_covariates=cat_covars,
        fit=True,
        existing_state=None,
        interaction_dummy=config.interaction_dummy,
        spline_knots=config.mean_spline_knots,
    )

    X = _build_design_matrix(work, state, fit=True)
    y = work[target_name].to_numpy(dtype=float)
    w = pd.to_numeric(work[weight_col], errors="coerce").fillna(0.0).to_numpy(dtype=float)

    beta = _fit_weighted_ridge(X, y, w, config.mean_ridge_alpha)
    pred = X @ beta
    rmse = float(np.sqrt(weighted_mean((y - pred) ** 2, w)))

    return ConditionalMeanModel(
        biomarker=biomarker,
        state=state,
        coefficients=beta,
        ridge_alpha=config.mean_ridge_alpha,
        n_obs=len(work),
        weighted_rmse=rmse,
    )


def estimate_variance(
    df: pd.DataFrame,
    biomarker: str,
    mean_model: ConditionalMeanModel,
    config: SimulationConfig,
    *,
    target_series: pd.Series | None = None,
    extra_cont_covars: list[str] | None = None,
    extra_cat_covars: list[str] | None = None,
) -> VarianceModel:
    """Estimate heteroskedastic sigma(age, Z) from weighted log-residual variance."""

    age_col = config.age_column
    weight_col = config.weight_column

    cont_covars, cat_covars = _assemble_covariate_columns(
        df,
        biomarker,
        config,
        extra_cont_covars=extra_cont_covars,
        extra_cat_covars=extra_cat_covars,
    )

    target_name = "__target__"
    model_df = df[[biomarker, age_col, weight_col, *cont_covars, *cat_covars]].copy()
    model_df[target_name] = pd.to_numeric(target_series, errors="coerce") if target_series is not None else pd.to_numeric(model_df[biomarker], errors="coerce")
    model_df = model_df[pd.to_numeric(model_df[weight_col], errors="coerce").fillna(0.0) > 0].copy()
    model_df[age_col] = pd.to_numeric(model_df[age_col], errors="coerce")
    model_df = model_df.dropna(subset=[target_name, age_col]).copy()

    mu = mean_model.predict(model_df)
    y = model_df[target_name].to_numpy(dtype=float)
    residual_sq = (y - mu) ** 2
    floor = float(np.quantile(residual_sq, config.variance_floor_quantile))
    floor = max(floor, config.epsilon)

    log_residual_var = np.log(residual_sq + floor)

    work, state = _prepare_design_inputs(
        model_df,
        age_column=age_col,
        continuous_covariates=cont_covars,
        categorical_covariates=cat_covars,
        fit=True,
        existing_state=None,
        interaction_dummy=config.interaction_dummy,
        spline_knots=config.variance_spline_knots,
    )

    X = _build_design_matrix(work, state, fit=True)
    w = pd.to_numeric(work[weight_col], errors="coerce").fillna(0.0).to_numpy(dtype=float)

    beta = _fit_weighted_ridge(X, log_residual_var, w, config.variance_ridge_alpha)

    return VarianceModel(
        biomarker=biomarker,
        state=state,
        coefficients=beta,
        ridge_alpha=config.variance_ridge_alpha,
        variance_floor=floor,
        n_obs=len(work),
    )


def _build_calibration_dataset(
    df: pd.DataFrame,
    biomarker: str,
    mean_model: ConditionalMeanModel,
    variance_model: VarianceModel,
    config: SimulationConfig,
    rng: np.random.Generator,
    *,
    model_class: str,
    transform_params: Mapping[str, float] | None,
    filter_mask: np.ndarray | None = None,
) -> tuple[list[dict[str, Any]], float]:
    age_col = config.age_column
    weight_col = config.weight_column

    cont_covars, cat_covars = _assemble_covariate_columns(df, biomarker, config)

    calib_df = df[[biomarker, age_col, weight_col, *cont_covars, *cat_covars]].copy()
    calib_df[biomarker] = pd.to_numeric(calib_df[biomarker], errors="coerce")
    calib_df[age_col] = pd.to_numeric(calib_df[age_col], errors="coerce")
    calib_df[weight_col] = pd.to_numeric(calib_df[weight_col], errors="coerce").fillna(0.0)

    if filter_mask is not None:
        mask = np.asarray(filter_mask, dtype=bool)
        calib_df = calib_df.loc[mask].copy()

    calib_df = calib_df[calib_df[weight_col] > 0].dropna(subset=[biomarker, age_col]).copy()

    age_values = np.sort(calib_df[age_col].dropna().unique())
    if len(age_values):
        age_values = age_values[age_values < age_values.max()]
    age_reference = float(np.median(age_values)) if len(age_values) else 50.0

    packs: list[dict[str, Any]] = []
    for age in age_values:
        current = calib_df[calib_df[age_col] == age].copy()
        nxt = calib_df[calib_df[age_col] == age + 1].copy()

        if len(current) < config.calibration_min_age_count or len(nxt) < config.calibration_min_age_count:
            continue

        sample_idx = _weighted_sample_indices(
            len(current),
            config.calibration_particles_per_age,
            current[weight_col].to_numpy(dtype=float),
            rng,
        )
        sampled = current.iloc[sample_idx].copy()

        x_t_raw = sampled[biomarker].to_numpy(dtype=float)
        y_t = _transform_values(x_t_raw, model_class, transform_params, epsilon=config.epsilon)
        base_profiles = sampled.drop(columns=[biomarker, weight_col])

        mu_t = _predict_mu_for_age(mean_model, base_profiles, age, age_col)
        mu_t1 = _predict_mu_for_age(mean_model, base_profiles, age + 1.0, age_col)
        sigma_t = _predict_sigma_for_age(variance_model, base_profiles, age, age_col)

        obs_next = nxt[biomarker].to_numpy(dtype=float)
        obs_next_w = nxt[weight_col].to_numpy(dtype=float)
        obs_next_var = weighted_variance(obs_next, obs_next_w)
        obs_next_mean = weighted_mean(obs_next, obs_next_w)

        packs.append(
            {
                "age": float(age),
                "y_t": y_t,
                "mu_t": mu_t,
                "mu_t1": mu_t1,
                "sigma_t": sigma_t,
                "obs_next_var": obs_next_var,
                "obs_next_mean": obs_next_mean,
                "obs_next": obs_next,
                "obs_next_w": obs_next_w,
            }
        )

    return packs, age_reference


def calibrate_kappa(
    df: pd.DataFrame,
    biomarker: str,
    mean_model: ConditionalMeanModel,
    variance_model: VarianceModel,
    bounds: tuple[float, float],
    config: SimulationConfig,
    *,
    model_class: str = "gaussian_ou",
    transform_params: Mapping[str, float] | None = None,
    filter_mask: np.ndarray | None = None,
) -> KappaCalibrationResult:
    """Calibrate kappa(age) by matching simulated and empirical age-specific variance."""

    rng = np.random.default_rng(config.random_seed + 17)
    packs, age_reference = _build_calibration_dataset(
        df,
        biomarker,
        mean_model,
        variance_model,
        config,
        rng,
        model_class=model_class,
        transform_params=transform_params,
        filter_mask=filter_mask,
    )

    if not packs:
        return KappaCalibrationResult(
            biomarker=biomarker,
            kappa0=0.4,
            kappa_age=0.0,
            age_reference=age_reference,
            kappa_floor=config.kappa_floor,
            kappa_ceiling=config.kappa_ceiling,
            objective_value=np.nan,
            calibration_table=pd.DataFrame(),
        )

    lower, upper = bounds

    def objective(k0: float, k_age: float) -> float:
        total = 0.0
        count = 0
        for pack in packs:
            age = pack["age"]
            y_t = pack["y_t"]
            mu_t = pack["mu_t"]
            mu_t1 = pack["mu_t1"]
            sigma_t = pack["sigma_t"]
            target_var = pack["obs_next_var"]
            target_mean = pack["obs_next_mean"]
            obs_next = pack["obs_next"]
            obs_next_w = pack["obs_next_w"]

            kappa = _kappa_from_params(np.array([age]), k0, k_age, age_reference, config)[0]
            alpha = mu_t1 - mu_t

            eps = rng.normal(size=len(y_t))
            y_next = y_t + alpha - kappa * (y_t - mu_t) + sigma_t * eps
            x_next = _inverse_transform_values(y_next, model_class, transform_params, epsilon=config.epsilon)
            x_next, _ = apply_reflective_bounds(x_next, lower, upper)

            sim_var = float(np.var(x_next, ddof=0))
            sim_mean = float(np.mean(x_next))
            wdist = weighted_wasserstein_distance(x_next, obs_next, None, obs_next_w)

            obs_sd = float(np.sqrt(max(target_var, config.epsilon)))
            scale = max(target_var, config.epsilon)
            var_term = ((sim_var - target_var) / scale) ** 2
            mean_term = ((sim_mean - target_mean) / obs_sd) ** 2
            wdist_term = (wdist / obs_sd) ** 2

            # Jointly optimize variance, distribution shape, and central tendency.
            total += 0.45 * var_term + 0.45 * wdist_term + 0.10 * mean_term
            count += 1

        return total / max(count, 1)

    k0_lo, k0_hi = config.kappa0_search_bounds
    ka_lo, ka_hi = config.kappa_age_search_bounds

    best_k0 = 0.4
    best_ka = 0.0
    best_obj = float("inf")

    for _ in range(config.kappa_refinement_rounds):
        k0_grid = np.linspace(k0_lo, k0_hi, config.kappa_grid_k0)
        ka_grid = np.linspace(ka_lo, ka_hi, config.kappa_grid_kage)

        for k0 in k0_grid:
            for ka in ka_grid:
                obj = objective(float(k0), float(ka))
                if obj < best_obj:
                    best_obj = obj
                    best_k0 = float(k0)
                    best_ka = float(ka)

        k0_span = (k0_hi - k0_lo) * 0.28
        ka_span = (ka_hi - ka_lo) * 0.28

        k0_lo = max(config.kappa0_search_bounds[0], best_k0 - k0_span)
        k0_hi = min(config.kappa0_search_bounds[1], best_k0 + k0_span)

        ka_lo = max(config.kappa_age_search_bounds[0], best_ka - ka_span)
        ka_hi = min(config.kappa_age_search_bounds[1], best_ka + ka_span)

    rows: list[dict[str, float]] = []
    for pack in packs:
        age = pack["age"]
        y_t = pack["y_t"]
        mu_t = pack["mu_t"]
        mu_t1 = pack["mu_t1"]
        sigma_t = pack["sigma_t"]
        target_var = pack["obs_next_var"]
        target_mean = pack["obs_next_mean"]
        obs_next = pack["obs_next"]
        obs_next_w = pack["obs_next_w"]

        kappa = _kappa_from_params(np.array([age]), best_k0, best_ka, age_reference, config)[0]
        alpha = mu_t1 - mu_t
        eps = rng.normal(size=len(y_t))

        y_next = y_t + alpha - kappa * (y_t - mu_t) + sigma_t * eps
        x_next = _inverse_transform_values(y_next, model_class, transform_params, epsilon=config.epsilon)
        x_next, _ = apply_reflective_bounds(x_next, lower, upper)

        sim_var = float(np.var(x_next, ddof=0))
        sim_mean = float(np.mean(x_next))
        wdist = weighted_wasserstein_distance(x_next, obs_next, None, obs_next_w)
        rel_err = abs(sim_var - target_var) / max(target_var, config.epsilon)

        rows.append(
            {
                "age": age,
                "sim_variance": sim_var,
                "nhanes_variance": target_var,
                "relative_error": rel_err,
                "sim_mean": sim_mean,
                "nhanes_mean": target_mean,
                "wasserstein": wdist,
                "kappa": kappa,
            }
        )

    return KappaCalibrationResult(
        biomarker=biomarker,
        kappa0=best_k0,
        kappa_age=best_ka,
        age_reference=age_reference,
        kappa_floor=config.kappa_floor,
        kappa_ceiling=config.kappa_ceiling,
        objective_value=best_obj,
        calibration_table=pd.DataFrame(rows),
    )


def _compute_raw_mean_rmse(
    df: pd.DataFrame,
    biomarker: str,
    mean_model: ConditionalMeanModel,
    config: SimulationConfig,
    *,
    model_class: str,
    transform_params: Mapping[str, float] | None,
    filter_mask: np.ndarray | None = None,
) -> tuple[float, int]:
    age_col = config.age_column
    weight_col = config.weight_column
    cont_covars, cat_covars = _assemble_covariate_columns(df, biomarker, config)

    work = df[[biomarker, age_col, weight_col, *cont_covars, *cat_covars]].copy()
    if filter_mask is not None:
        work = work.loc[np.asarray(filter_mask, dtype=bool)].copy()

    work[biomarker] = pd.to_numeric(work[biomarker], errors="coerce")
    work[age_col] = pd.to_numeric(work[age_col], errors="coerce")
    work[weight_col] = pd.to_numeric(work[weight_col], errors="coerce").fillna(0.0)
    work = work[(work[weight_col] > 0)].dropna(subset=[biomarker, age_col]).copy()

    if work.empty:
        return np.nan, 0

    pred_trans = mean_model.predict(work)
    pred_raw = _inverse_transform_values(pred_trans, model_class, transform_params, epsilon=config.epsilon)

    y = work[biomarker].to_numpy(dtype=float)
    w = work[weight_col].to_numpy(dtype=float)
    rmse = float(np.sqrt(weighted_mean((y - pred_raw) ** 2, w)))
    return rmse, len(work)


def _data_driven_lipid_caps(df: pd.DataFrame) -> dict[str, float]:
    caps: dict[str, float] = {}
    for biomarker in LIPID_BIOMARKERS:
        if biomarker not in df.columns:
            continue
        ser = pd.to_numeric(df[biomarker], errors="coerce").dropna()
        if ser.empty:
            caps[biomarker] = DEFAULT_BOUNDS[biomarker][1]
            continue
        p999 = float(np.quantile(ser, 0.999))
        # Cap from empirical 99.9th percentile to retain tails without allowing implausible extremes.
        caps[biomarker] = max(DEFAULT_BOUNDS[biomarker][0] + 1.0, p999)
    return caps


def _nearest_psd_correlation(matrix: np.ndarray) -> np.ndarray:
    mat = np.asarray(matrix, dtype=float)
    mat = 0.5 * (mat + mat.T)

    vals, vecs = np.linalg.eigh(mat)
    vals = np.clip(vals, 0.05, None)
    psd = vecs @ np.diag(vals) @ vecs.T

    d = np.sqrt(np.diag(psd))
    d[d <= 0] = 1.0
    corr = psd / np.outer(d, d)
    corr = np.clip(corr, -0.95, 0.95)
    np.fill_diagonal(corr, 1.0)
    return corr


def _fit_transition_model(df: pd.DataFrame, config: SimulationConfig) -> TransitionModel:
    work = df.copy()
    y = pd.to_numeric(work.get("lipid_lowering_use", 0.0), errors="coerce").fillna(0.0)
    y = (y > 0).astype(int)

    age_col = config.age_column
    weight_col = config.weight_column

    keep_cols = [age_col, "bmi", "pir", "statin_use", "lipid_lowering_use", "sex", "race_ethnicity", weight_col]
    for col in keep_cols:
        if col not in work.columns:
            work[col] = np.nan

    tmp = work[keep_cols].copy()
    tmp[weight_col] = pd.to_numeric(tmp[weight_col], errors="coerce").fillna(0.0)
    tmp = tmp[tmp[weight_col] > 0].copy()
    y = y.loc[tmp.index]

    # Do not include lipid_lowering_use itself as a predictor to avoid target leakage.
    numeric = [age_col, "bmi", "pir", "statin_use"]
    if "medication_use" in df.columns:
        tmp["medication_use"] = pd.to_numeric(df.loc[tmp.index, "medication_use"], errors="coerce")
        numeric.append("medication_use")
    categorical = ["sex", "race_ethnicity"]

    means: dict[str, float] = {}
    stds: dict[str, float] = {}
    num_parts: list[np.ndarray] = []
    for col in numeric:
        ser = pd.to_numeric(tmp[col], errors="coerce")
        med = _safe_float(ser.median(skipna=True), 0.0)
        vals = ser.fillna(med)
        mean = _safe_float(vals.mean(), 0.0)
        std = _safe_float(vals.std(ddof=0), 1.0)
        if std <= 0:
            std = 1.0
        means[col] = mean
        stds[col] = std
        num_parts.append(((vals - mean) / std).to_numpy(dtype=float).reshape(-1, 1))

    cat_levels: dict[str, list[str]] = {}
    cat_parts: list[np.ndarray] = []
    feature_names: list[str] = []

    for col in categorical:
        ser = tmp[col].fillna("Unknown").astype(str)
        levels = sorted(ser.unique().tolist())
        if not levels:
            levels = ["Unknown"]
        cat_levels[col] = levels

    for col in categorical:
        ser = tmp[col].fillna("Unknown").astype(str)
        for level in cat_levels[col]:
            cat_parts.append((ser == level).to_numpy(dtype=float).reshape(-1, 1))
            feature_names.append(f"{col}__{level}")

    X = np.concatenate([*num_parts, *cat_parts], axis=1) if cat_parts else np.concatenate(num_parts, axis=1)
    weights = tmp[weight_col].to_numpy(dtype=float)

    if y.nunique() < 2:
        prev = float(np.clip(weighted_mean(y.to_numpy(dtype=float), weights), 1e-4, 1 - 1e-4))
        intercept = float(np.log(prev / (1.0 - prev)))
        coef = np.zeros(X.shape[1], dtype=float)
    else:
        model = LogisticRegression(
            max_iter=800,
            C=1.5,
            solver="lbfgs",
        )
        model.fit(X, y.to_numpy(dtype=int), sample_weight=weights)
        intercept = float(model.intercept_[0])
        coef = model.coef_[0].astype(float)

    state = TransitionDesignState(
        numeric_features=numeric,
        numeric_means=means,
        numeric_stds=stds,
        categorical_features=categorical,
        categorical_levels=cat_levels,
        feature_names=[*numeric, *feature_names],
    )

    transition = TransitionModel(
        state=state,
        coefficients=coef,
        intercept=intercept,
        persistence_coef=1.6,
    )

    transition.persistence_coef = _calibrate_persistence_coef(df, transition, config)
    return transition


def _build_transition_matrix(
    df: pd.DataFrame,
    state: TransitionDesignState,
    *,
    fit: bool,
) -> np.ndarray:
    if fit:
        raise ValueError("fit=True not supported in _build_transition_matrix")

    num_parts: list[np.ndarray] = []
    for col in state.numeric_features:
        ser = pd.to_numeric(df[col], errors="coerce") if col in df.columns else pd.Series(np.nan, index=df.index)
        mean = state.numeric_means[col]
        std = state.numeric_stds[col]
        vals = ser.fillna(mean)
        num_parts.append(((vals - mean) / std).to_numpy(dtype=float).reshape(-1, 1))

    cat_parts: list[np.ndarray] = []
    for col in state.categorical_features:
        ser = df[col].fillna("Unknown").astype(str) if col in df.columns else pd.Series("Unknown", index=df.index)
        for level in state.categorical_levels[col]:
            cat_parts.append((ser == level).to_numpy(dtype=float).reshape(-1, 1))

    return np.concatenate([*num_parts, *cat_parts], axis=1) if cat_parts else np.concatenate(num_parts, axis=1)


def _calibrate_persistence_coef(
    df: pd.DataFrame,
    transition_model: TransitionModel,
    config: SimulationConfig,
) -> float:
    age_col = config.age_column
    weight_col = config.weight_column

    work = df[[age_col, weight_col, "lipid_lowering_use", "bmi", "pir", "statin_use", "sex", "race_ethnicity"]].copy()
    work[age_col] = pd.to_numeric(work[age_col], errors="coerce")
    work[weight_col] = pd.to_numeric(work[weight_col], errors="coerce").fillna(0.0)
    work["lipid_lowering_use"] = (pd.to_numeric(work["lipid_lowering_use"], errors="coerce").fillna(0.0) > 0).astype(float)
    work = work[(work[weight_col] > 0)].dropna(subset=[age_col]).copy()

    if work.empty:
        return 1.6

    ages = np.sort(work[age_col].unique())
    ages = ages[ages < ages.max()]

    rng = np.random.default_rng(config.random_seed + 191)

    def obj(a3: float) -> float:
        losses: list[float] = []
        for age in ages:
            cur = work[work[age_col] == age].copy()
            nxt = work[work[age_col] == age + 1].copy()
            if len(cur) < config.calibration_min_age_count or len(nxt) < config.calibration_min_age_count:
                continue

            idx = _weighted_sample_indices(
                len(cur),
                config.calibration_particles_per_age,
                cur[weight_col].to_numpy(dtype=float),
                rng,
            )
            sampled = cur.iloc[idx].copy()
            prev_state = sampled["lipid_lowering_use"].to_numpy(dtype=float)

            sampled_next = sampled.copy()
            sampled_next[age_col] = age + 1.0
            base_logit = transition_model.logit_base(sampled_next)
            p = 1.0 / (1.0 + np.exp(-np.clip(base_logit + a3 * prev_state, -20.0, 20.0)))
            sim_prev = float(np.mean(p))

            obs_prev = weighted_mean(
                nxt["lipid_lowering_use"].to_numpy(dtype=float),
                nxt[weight_col].to_numpy(dtype=float),
            )
            losses.append((sim_prev - obs_prev) ** 2)

        if not losses:
            return np.inf
        return float(np.mean(losses))

    grid = np.linspace(0.4, 3.2, 15)
    vals = [(a3, obj(float(a3))) for a3 in grid]
    vals = [v for v in vals if np.isfinite(v[1])]
    if not vals:
        return 1.6

    vals.sort(key=lambda x: x[1])
    return float(vals[0][0])


def _fit_lipid_regime_bundle(
    df: pd.DataFrame,
    config: SimulationConfig,
    biomarkers: list[str],
) -> dict[str, BiomarkerProcessModel]:
    transition_model = _fit_transition_model(df, config)

    regime_col = "lipid_lowering_use"
    regime_values = (pd.to_numeric(df[regime_col], errors="coerce").fillna(0.0) > 0).astype(int)

    caps = _data_driven_lipid_caps(df)

    by_marker: dict[str, dict[str, RegimeEmissionModel]] = {b: {} for b in biomarkers}

    for biomarker in biomarkers:
        for regime in (0, 1):
            mask = regime_values.to_numpy(dtype=int) == regime
            n_reg = int(mask.sum())
            use_mask = mask if n_reg >= config.min_regime_obs else None

            mean_model = fit_conditional_mean(
                df,
                biomarker,
                config,
                extra_cont_covars=["statin_use", "lipid_lowering_use", "bmi", "pir"],
            ) if use_mask is None else fit_conditional_mean(
                df.loc[use_mask].copy(),
                biomarker,
                config,
                extra_cont_covars=["statin_use", "lipid_lowering_use", "bmi", "pir"],
            )

            variance_model = estimate_variance(
                df if use_mask is None else df.loc[use_mask].copy(),
                biomarker,
                mean_model,
                config,
                extra_cont_covars=["statin_use", "lipid_lowering_use", "bmi", "pir"],
            )

            lower = DEFAULT_BOUNDS[biomarker][0]
            upper = caps.get(biomarker, DEFAULT_BOUNDS[biomarker][1])
            kappa = calibrate_kappa(
                df,
                biomarker,
                mean_model,
                variance_model,
                bounds=(lower, upper),
                config=config,
                model_class="gaussian_ou",
                transform_params=None,
                filter_mask=use_mask,
            )

            by_marker[biomarker][str(regime)] = RegimeEmissionModel(
                mean_model=mean_model,
                variance_model=variance_model,
                kappa_result=kappa,
                n_obs=n_reg,
            )

    regime_corr: dict[str, np.ndarray] = {}
    corr_source = df[[*LIPID_BIOMARKERS, config.age_column, config.weight_column, regime_col, "bmi", "pir", "statin_use", "sex", "race_ethnicity", "region_proxy", "height_cm"]].copy()
    for col in LIPID_BIOMARKERS:
        corr_source[col] = pd.to_numeric(corr_source[col], errors="coerce")
    corr_source[config.age_column] = pd.to_numeric(corr_source[config.age_column], errors="coerce")
    corr_source = corr_source.dropna(subset=[*LIPID_BIOMARKERS, config.age_column]).copy()
    corr_source[regime_col] = (pd.to_numeric(corr_source[regime_col], errors="coerce").fillna(0.0) > 0).astype(int)

    for regime in (0, 1):
        reg_df = corr_source[corr_source[regime_col] == regime].copy()
        if len(reg_df) < 300:
            regime_corr[str(regime)] = np.eye(3, dtype=float)
            continue

        resid_cols: list[np.ndarray] = []
        for biomarker in LIPID_BIOMARKERS:
            model = by_marker[biomarker][str(regime)]
            mu = model.mean_model.predict(reg_df)
            sigma = model.variance_model.predict_sigma(reg_df)
            sigma = np.where(sigma <= 1e-6, 1e-6, sigma)
            resid = (reg_df[biomarker].to_numpy(dtype=float) - mu) / sigma
            resid_cols.append(resid)

        resid_mat = np.column_stack(resid_cols)
        corr = np.corrcoef(resid_mat, rowvar=False)
        corr = 0.85 * corr + 0.15 * np.eye(3)
        regime_corr[str(regime)] = _nearest_psd_correlation(corr)

    models: dict[str, BiomarkerProcessModel] = {}

    for biomarker in biomarkers:
        lower = DEFAULT_BOUNDS[biomarker][0]
        upper = caps.get(biomarker, DEFAULT_BOUNDS[biomarker][1])
        regime_models = by_marker[biomarker]

        prev_treated = weighted_mean(
            (pd.to_numeric(df[regime_col], errors="coerce").fillna(0.0) > 0).astype(float).to_numpy(),
            pd.to_numeric(df[config.weight_column], errors="coerce").fillna(0.0).to_numpy(),
        )
        prev_treated = float(np.clip(prev_treated, 0.0, 1.0))

        k0 = (1 - prev_treated) * regime_models["0"].kappa_result.kappa0 + prev_treated * regime_models["1"].kappa_result.kappa0
        ka = (1 - prev_treated) * regime_models["0"].kappa_result.kappa_age + prev_treated * regime_models["1"].kappa_result.kappa_age
        obj = (1 - prev_treated) * regime_models["0"].kappa_result.objective_value + prev_treated * regime_models["1"].kappa_result.objective_value

        calib_tbl = pd.concat(
            [
                regime_models["0"].kappa_result.calibration_table.assign(regime=0),
                regime_models["1"].kappa_result.calibration_table.assign(regime=1),
            ],
            ignore_index=True,
        )

        pooled_kappa = KappaCalibrationResult(
            biomarker=biomarker,
            kappa0=float(k0),
            kappa_age=float(ka),
            age_reference=float(np.nanmean([regime_models["0"].kappa_result.age_reference, regime_models["1"].kappa_result.age_reference])),
            kappa_floor=config.kappa_floor,
            kappa_ceiling=config.kappa_ceiling,
            objective_value=float(obj),
            calibration_table=calib_tbl,
        )

        # Weighted in-sample RMSE from observed regime proxy.
        work = df[[biomarker, config.weight_column, regime_col, config.age_column, "bmi", "pir", "statin_use", "sex", "race_ethnicity", "region_proxy", "height_cm"]].copy()
        work[biomarker] = pd.to_numeric(work[biomarker], errors="coerce")
        work[config.weight_column] = pd.to_numeric(work[config.weight_column], errors="coerce").fillna(0.0)
        work[regime_col] = (pd.to_numeric(work[regime_col], errors="coerce").fillna(0.0) > 0).astype(int)
        work = work[(work[config.weight_column] > 0)].dropna(subset=[biomarker, config.age_column]).copy()

        if work.empty:
            rmse = np.nan
            n_obs = 0
        else:
            pred = np.zeros(len(work), dtype=float)
            for regime in (0, 1):
                idx = work[regime_col].to_numpy(dtype=int) == regime
                if not idx.any():
                    continue
                pred[idx] = regime_models[str(regime)].mean_model.predict(work.loc[idx])
            rmse = float(np.sqrt(weighted_mean((work[biomarker].to_numpy(dtype=float) - pred) ** 2, work[config.weight_column].to_numpy(dtype=float))))
            n_obs = int(len(work))

        models[biomarker] = BiomarkerProcessModel(
            biomarker=biomarker,
            model_class="lipid_regime",
            bounds=(lower, upper),
            regimes=regime_models,
            transition_model=transition_model,
            regime_corr={k: np.asarray(v, dtype=float) for k, v in regime_corr.items()},
            lipid_order=LIPID_BIOMARKERS,
            kappa_result=pooled_kappa,
            mean_model_rmse=rmse,
            n_obs=n_obs,
        )

    return models


def fit_biomarker_process(
    df: pd.DataFrame,
    biomarker: str,
    config: SimulationConfig,
    bounds: tuple[float, float] | None = None,
) -> BiomarkerProcessModel:
    model_class = _marker_model_class(biomarker)

    if model_class == "lipid_regime":
        raise ValueError("Use _fit_lipid_regime_bundle for lipid biomarkers")

    if model_class == "bounded_logit_ou" and biomarker == "egfr":
        # Evaluate upper bounds and keep the one with lower validation score.
        candidates = [120.0, 130.0]
        best_model: BiomarkerProcessModel | None = None
        best_score = float("inf")

        for upper in candidates:
            params = {"lower": 0.0, "upper": upper, "eps": config.epsilon}
            transformed = pd.to_numeric(df[biomarker], errors="coerce")
            transformed = pd.Series(_transform_values(transformed.to_numpy(dtype=float), "bounded_logit_ou", params, epsilon=config.epsilon), index=df.index)

            mean_model = fit_conditional_mean(df, biomarker, config, target_series=transformed)
            variance_model = estimate_variance(df, biomarker, mean_model, config, target_series=transformed)

            process_bounds = (0.0, upper)
            kappa_result = calibrate_kappa(
                df,
                biomarker,
                mean_model,
                variance_model,
                process_bounds,
                config,
                model_class="bounded_logit_ou",
                transform_params=params,
            )

            rmse_raw, n_obs = _compute_raw_mean_rmse(
                df,
                biomarker,
                mean_model,
                config,
                model_class="bounded_logit_ou",
                transform_params=params,
            )

            candidate_model = BiomarkerProcessModel(
                biomarker=biomarker,
                model_class="bounded_logit_ou",
                bounds=process_bounds,
                mean_model=mean_model,
                variance_model=variance_model,
                kappa_result=kappa_result,
                transform_params=params,
                mean_model_rmse=rmse_raw,
                n_obs=n_obs,
            )

            quick_val = validate_model(candidate_model, df, config, output_dir=None)
            if quick_val.overall_score < best_score:
                best_score = quick_val.overall_score
                best_model = candidate_model

        if best_model is None:
            raise RuntimeError("Failed to fit eGFR bounded model")
        return best_model

    process_bounds = bounds if bounds is not None else DEFAULT_BOUNDS[biomarker]

    if model_class == "log_ou":
        raw = pd.to_numeric(df[biomarker], errors="coerce").fillna(0.0)
        transformed = pd.Series(_transform_values(raw.to_numpy(dtype=float), "log_ou", None, epsilon=config.epsilon), index=df.index)

        mean_model = fit_conditional_mean(df, biomarker, config, target_series=transformed)
        variance_model = estimate_variance(df, biomarker, mean_model, config, target_series=transformed)

        if biomarker in df.columns:
            p999 = float(np.nanquantile(pd.to_numeric(df[biomarker], errors="coerce"), 0.999))
            process_bounds = (0.0, max(5.0, p999))

        kappa_result = calibrate_kappa(
            df,
            biomarker,
            mean_model,
            variance_model,
            process_bounds,
            config,
            model_class="log_ou",
            transform_params=None,
        )

        rmse_raw, n_obs = _compute_raw_mean_rmse(
            df,
            biomarker,
            mean_model,
            config,
            model_class="log_ou",
            transform_params=None,
        )

        return BiomarkerProcessModel(
            biomarker=biomarker,
            model_class="log_ou",
            bounds=process_bounds,
            mean_model=mean_model,
            variance_model=variance_model,
            kappa_result=kappa_result,
            transform_params=None,
            mean_model_rmse=rmse_raw,
            n_obs=n_obs,
        )

    # Default Gaussian OU.
    mean_model = fit_conditional_mean(df, biomarker, config)
    variance_model = estimate_variance(df, biomarker, mean_model, config)
    kappa_result = calibrate_kappa(
        df,
        biomarker,
        mean_model,
        variance_model,
        process_bounds,
        config,
        model_class="gaussian_ou",
        transform_params=None,
    )

    rmse_raw, n_obs = _compute_raw_mean_rmse(
        df,
        biomarker,
        mean_model,
        config,
        model_class="gaussian_ou",
        transform_params=None,
    )

    return BiomarkerProcessModel(
        biomarker=biomarker,
        model_class="gaussian_ou",
        bounds=process_bounds,
        mean_model=mean_model,
        variance_model=variance_model,
        kappa_result=kappa_result,
        transform_params=None,
        mean_model_rmse=rmse_raw,
        n_obs=n_obs,
    )


def _single_state_step(
    process_model: BiomarkerProcessModel,
    profiles: pd.DataFrame,
    current_values: np.ndarray,
    age: float,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
    if process_model.mean_model is None or process_model.variance_model is None or process_model.kappa_result is None:
        raise ValueError("single-state model missing fitted components")

    age_col = process_model.mean_model.state.age_column

    row_t = profiles.copy()
    row_t[age_col] = float(age)

    row_t1 = profiles.copy()
    row_t1[age_col] = float(age + 1)

    mu_t = process_model.mean_model.predict(row_t)
    mu_t1 = process_model.mean_model.predict(row_t1)
    sigma_t = process_model.variance_model.predict_sigma(row_t)

    kappa = process_model.kappa_result.kappa(np.full(len(profiles), float(age), dtype=float))
    alpha = mu_t1 - mu_t

    y_t = _transform_values(current_values, process_model.model_class, process_model.transform_params)
    eps = rng.normal(size=len(profiles))
    y_next = y_t + alpha - kappa * (y_t - mu_t) + sigma_t * eps

    x_next = _inverse_transform_values(y_next, process_model.model_class, process_model.transform_params)
    x_next, corrections = apply_reflective_bounds(x_next, process_model.bounds[0], process_model.bounds[1])
    return x_next, corrections


def _simulate_lipid_single_trajectory(
    process_model: BiomarkerProcessModel,
    profile: Mapping[str, Any],
    start_age: int,
    end_age: int,
    n_simulations: int,
    random_seed: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    biomarker = process_model.biomarker
    if process_model.regimes is None or process_model.transition_model is None:
        raise ValueError("lipid regime model missing regime components")

    rng = np.random.default_rng(random_seed)
    ages = np.arange(int(start_age), int(end_age) + 1)
    n_steps = len(ages)

    trajectories = np.zeros((n_simulations, n_steps), dtype=float)

    base_profile = dict(profile)
    age_col = config_age_col = process_model.regimes["0"].mean_model.state.age_column

    base_df = pd.DataFrame([{**base_profile, age_col: float(start_age)}])

    init_state = int(_safe_float(base_profile.get("lipid_lowering_use", base_profile.get("statin_use", 0.0)), 0.0) > 0)
    regime_state = np.full(n_simulations, init_state, dtype=int)

    reg_model = process_model.regimes[str(init_state)]
    init_default = reg_model.mean_model.predict(base_df)[0]
    x0 = _safe_float(base_profile.get(biomarker, init_default), init_default)
    trajectories[:, 0] = x0

    boundary_logs: list[dict[str, Any]] = []

    for t_idx, age in enumerate(ages[:-1]):
        row_t = pd.DataFrame([{**base_profile, age_col: float(age)}])
        row_t1 = pd.DataFrame([{**base_profile, age_col: float(age + 1)}])

        p_on_scalar = process_model.transition_model.probability(row_t1, np.array([float(regime_state.mean())]))[0]
        p_on = np.clip(p_on_scalar + 0.15 * (regime_state - regime_state.mean()), 0.001, 0.999)
        next_state = rng.binomial(1, p_on, size=n_simulations)

        next_values = np.zeros(n_simulations, dtype=float)
        corrections = np.zeros(n_simulations, dtype=int)

        for regime in (0, 1):
            idx = np.where(next_state == regime)[0]
            if len(idx) == 0:
                continue
            rmod = process_model.regimes[str(regime)]

            mu_t = rmod.mean_model.predict(row_t)[0]
            mu_t1 = rmod.mean_model.predict(row_t1)[0]
            sigma_t = rmod.variance_model.predict_sigma(row_t)[0]
            kappa_t = rmod.kappa_result.kappa(np.array([float(age)]))[0]

            eps = rng.normal(size=len(idx))
            alpha = mu_t1 - mu_t

            sim = trajectories[idx, t_idx] + alpha - kappa_t * (trajectories[idx, t_idx] - mu_t) + sigma_t * eps
            sim, corr = apply_reflective_bounds(sim, process_model.bounds[0], process_model.bounds[1])
            next_values[idx] = sim
            corrections[idx] = corr

        if np.any(corrections > 0):
            boundary_logs.append(
                {
                    "biomarker": biomarker,
                    "age": int(age + 1),
                    "n_corrected": int(np.sum(corrections > 0)),
                    "mean_reflections": float(np.mean(corrections[corrections > 0])),
                }
            )

        trajectories[:, t_idx + 1] = next_values
        regime_state = next_state

    trajectory_df = pd.DataFrame(
        {
            "simulation_id": np.repeat(np.arange(n_simulations), n_steps),
            "age": np.tile(ages, n_simulations),
            biomarker: trajectories.reshape(-1),
        }
    )

    boundary_df = pd.DataFrame(boundary_logs)
    if boundary_df.empty:
        boundary_df = pd.DataFrame(columns=["biomarker", "age", "n_corrected", "mean_reflections"])

    return trajectory_df, boundary_df


def simulate_trajectory(
    process_model: BiomarkerProcessModel,
    profile: Mapping[str, Any],
    start_age: int,
    end_age: int,
    n_simulations: int = 1000,
    random_seed: int = 42,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Simulate annual trajectories for one biomarker."""

    if process_model.model_class == "lipid_regime":
        return _simulate_lipid_single_trajectory(
            process_model,
            profile=profile,
            start_age=start_age,
            end_age=end_age,
            n_simulations=n_simulations,
            random_seed=random_seed,
        )

    biomarker = process_model.biomarker
    if process_model.mean_model is None:
        raise ValueError("model missing mean_model")

    age_col = process_model.mean_model.state.age_column
    rng = np.random.default_rng(random_seed)

    ages = np.arange(int(start_age), int(end_age) + 1)
    n_steps = len(ages)

    trajectories = np.zeros((n_simulations, n_steps), dtype=float)

    base_profile = {k: v for k, v in profile.items()}
    row0 = pd.DataFrame([{**base_profile, age_col: float(start_age)}])

    baseline_default_trans = process_model.mean_model.predict(row0)[0]
    baseline_default = _inverse_transform_values(np.array([baseline_default_trans]), process_model.model_class, process_model.transform_params)[0]

    x0 = _safe_float(profile.get(biomarker, baseline_default), baseline_default)
    x0 = float(np.clip(x0, process_model.bounds[0], process_model.bounds[1]))
    trajectories[:, 0] = x0

    boundary_logs: list[dict[str, Any]] = []

    static_profiles = pd.DataFrame([{**base_profile} for _ in range(n_simulations)])

    for t_idx, age in enumerate(ages[:-1]):
        next_values, corrections = _single_state_step(
            process_model,
            static_profiles,
            trajectories[:, t_idx],
            float(age),
            rng,
        )

        if np.any(corrections > 0):
            boundary_logs.append(
                {
                    "biomarker": biomarker,
                    "age": int(age + 1),
                    "n_corrected": int(np.sum(corrections > 0)),
                    "mean_reflections": float(np.mean(corrections[corrections > 0])),
                }
            )

        trajectories[:, t_idx + 1] = next_values

    trajectory_df = pd.DataFrame(
        {
            "simulation_id": np.repeat(np.arange(n_simulations), n_steps),
            "age": np.tile(ages, n_simulations),
            biomarker: trajectories.reshape(-1),
        }
    )

    boundary_df = pd.DataFrame(boundary_logs)
    if boundary_df.empty:
        boundary_df = pd.DataFrame(columns=["biomarker", "age", "n_corrected", "mean_reflections"])

    return trajectory_df, boundary_df


def _simulate_lipid_panel_joint(
    lipid_models: Mapping[str, BiomarkerProcessModel],
    profile: Mapping[str, Any],
    start_age: int,
    end_age: int,
    n_simulations: int,
    random_seed: int,
) -> tuple[list[pd.DataFrame], list[pd.DataFrame]]:
    if not lipid_models:
        return [], []

    first = next(iter(lipid_models.values()))
    if first.transition_model is None:
        raise ValueError("lipid models missing transition model")

    transition = first.transition_model
    order = list(first.lipid_order or LIPID_BIOMARKERS)
    age_col = first.regimes["0"].mean_model.state.age_column if first.regimes is not None else "age"

    rng = np.random.default_rng(random_seed)

    ages = np.arange(int(start_age), int(end_age) + 1)
    n_steps = len(ages)

    trajectories: dict[str, np.ndarray] = {b: np.zeros((n_simulations, n_steps), dtype=float) for b in order if b in lipid_models}

    base_profile = dict(profile)
    s0 = int(_safe_float(base_profile.get("lipid_lowering_use", base_profile.get("statin_use", 0.0)), 0.0) > 0)
    regime_state = np.full(n_simulations, s0, dtype=int)

    row0 = pd.DataFrame([{**base_profile, age_col: float(start_age)}])

    for biomarker in trajectories:
        model = lipid_models[biomarker]
        if model.regimes is None:
            continue
        init_model = model.regimes[str(s0)]
        default = init_model.mean_model.predict(row0)[0]
        x0 = _safe_float(base_profile.get(biomarker, default), default)
        x0 = float(np.clip(x0, model.bounds[0], model.bounds[1]))
        trajectories[biomarker][:, 0] = x0

    boundary_logs: list[pd.DataFrame] = []

    for t_idx, age in enumerate(ages[:-1]):
        row_t = pd.DataFrame([{**base_profile, age_col: float(age)}])
        row_t1 = pd.DataFrame([{**base_profile, age_col: float(age + 1)}])

        logit_base = transition.logit_base(row_t1)[0]
        p_on = 1.0 / (1.0 + np.exp(-np.clip(logit_base + transition.persistence_coef * regime_state, -20.0, 20.0)))
        p_on = np.clip(p_on, 0.001, 0.999)
        next_state = rng.binomial(1, p_on, size=n_simulations)

        corr_by_regime = first.regime_corr or {"0": np.eye(3), "1": np.eye(3)}

        step_logs: list[dict[str, Any]] = []
        for regime in (0, 1):
            idx = np.where(next_state == regime)[0]
            if len(idx) == 0:
                continue

            corr = np.asarray(corr_by_regime.get(str(regime), np.eye(len(order))), dtype=float)
            if corr.shape[0] != len(order):
                corr = np.eye(len(order), dtype=float)

            z = rng.multivariate_normal(mean=np.zeros(len(order), dtype=float), cov=corr, size=len(idx))

            for j, biomarker in enumerate(order):
                if biomarker not in trajectories:
                    continue
                model = lipid_models[biomarker]
                if model.regimes is None:
                    continue
                em = model.regimes[str(regime)]

                mu_t = em.mean_model.predict(row_t)[0]
                mu_t1 = em.mean_model.predict(row_t1)[0]
                sigma_t = em.variance_model.predict_sigma(row_t)[0]
                kappa_t = em.kappa_result.kappa(np.array([float(age)]))[0]

                alpha = mu_t1 - mu_t
                x_prev = trajectories[biomarker][idx, t_idx]
                x_next = x_prev + alpha - kappa_t * (x_prev - mu_t) + sigma_t * z[:, j]
                x_next, corr_count = apply_reflective_bounds(x_next, model.bounds[0], model.bounds[1])
                trajectories[biomarker][idx, t_idx + 1] = x_next

                if np.any(corr_count > 0):
                    step_logs.append(
                        {
                            "biomarker": biomarker,
                            "age": int(age + 1),
                            "n_corrected": int(np.sum(corr_count > 0)),
                            "mean_reflections": float(np.mean(corr_count[corr_count > 0])),
                        }
                    )

        if step_logs:
            boundary_logs.append(pd.DataFrame(step_logs))

        regime_state = next_state

    traj_frames: list[pd.DataFrame] = []
    for biomarker, mat in trajectories.items():
        traj = pd.DataFrame(
            {
                "simulation_id": np.repeat(np.arange(n_simulations), n_steps),
                "age": np.tile(ages, n_simulations),
                biomarker: mat.reshape(-1),
            }
        )
        traj_frames.append(traj)

    boundary_frames = boundary_logs if boundary_logs else [pd.DataFrame(columns=["biomarker", "age", "n_corrected", "mean_reflections"])]
    return traj_frames, boundary_frames


def _looks_like_model_mapping(obj: Any) -> bool:
    if not isinstance(obj, Mapping) or not obj:
        return False
    first_val = next(iter(obj.values()))
    return isinstance(first_val, BiomarkerProcessModel)


def simulate_biomarkers(
    *args: Any,
    **kwargs: Any,
) -> dict[str, pd.DataFrame]:
    """Simulate all fitted biomarkers for one profile.

    Supports:
    - simulate_biomarkers(process_models, profile, start_age, end_age, ...)
    - simulate_biomarkers(profile, start_age, end_age, ..., process_models=...)
    """

    if not args:
        raise TypeError("simulate_biomarkers expects positional arguments")

    process_models: Mapping[str, BiomarkerProcessModel]
    profile: Mapping[str, Any]

    if _looks_like_model_mapping(args[0]):
        process_models = args[0]
        if len(args) < 4:
            raise TypeError("legacy call requires process_models, profile, start_age, end_age")
        profile = args[1]
        start_age = int(args[2])
        end_age = int(args[3])
        n_simulations = int(kwargs.get("n_simulations", args[4] if len(args) > 4 else 1000))
        random_seed = int(kwargs.get("random_seed", args[5] if len(args) > 5 else 42))
    else:
        profile = args[0]
        if len(args) < 3:
            raise TypeError("call style requires profile, start_age, end_age")
        start_age = int(args[1])
        end_age = int(args[2])
        n_simulations = int(kwargs.get("n_sims", kwargs.get("n_simulations", args[3] if len(args) > 3 else 1000)))
        random_seed = int(kwargs.get("random_seed", 42))

        provided = kwargs.get("process_models")
        if provided is None:
            artifact = Path(kwargs.get("model_artifact", "outputs/stage1_biomarker_simulation/stage1_biomarker_models.joblib"))
            process_models = load_process_models(artifact)
        else:
            process_models = provided

    rng = np.random.default_rng(random_seed)

    traj_frames: list[pd.DataFrame] = []
    boundary_frames: list[pd.DataFrame] = []

    lipid_keys = [b for b in LIPID_BIOMARKERS if b in process_models and process_models[b].model_class == "lipid_regime"]
    used_lipid = set()

    if len(lipid_keys) == len(LIPID_BIOMARKERS):
        seed = int(rng.integers(0, 2**31 - 1))
        lipid_models = {k: process_models[k] for k in lipid_keys}
        lipid_traj, lipid_bounds = _simulate_lipid_panel_joint(
            lipid_models,
            profile=profile,
            start_age=start_age,
            end_age=end_age,
            n_simulations=n_simulations,
            random_seed=seed,
        )

        for frame in lipid_traj:
            biomarker = next(c for c in frame.columns if c not in {"simulation_id", "age"})
            long_df = frame.rename(columns={biomarker: "value"})
            long_df["biomarker"] = biomarker
            traj_frames.append(long_df)
            used_lipid.add(biomarker)

        for bdf in lipid_bounds:
            if not bdf.empty:
                boundary_frames.append(bdf)

    for biomarker, model in process_models.items():
        if biomarker in used_lipid:
            continue

        seed = int(rng.integers(0, 2**31 - 1))
        traj_df, boundary_df = simulate_trajectory(
            model,
            profile=profile,
            start_age=start_age,
            end_age=end_age,
            n_simulations=n_simulations,
            random_seed=seed,
        )

        long_df = traj_df.rename(columns={biomarker: "value"})
        long_df["biomarker"] = biomarker
        traj_frames.append(long_df)

        if not boundary_df.empty:
            boundary_frames.append(boundary_df)

    trajectories = pd.concat(traj_frames, ignore_index=True) if traj_frames else pd.DataFrame(columns=["simulation_id", "age", "value", "biomarker"])

    boundaries = (
        pd.concat(boundary_frames, ignore_index=True)
        if boundary_frames
        else pd.DataFrame(columns=["biomarker", "age", "n_corrected", "mean_reflections"])
    )

    summary = (
        trajectories.groupby(["biomarker", "age"], as_index=False)["value"]
        .agg(
            mean="mean",
            p05=lambda s: np.quantile(s, 0.05),
            p50=lambda s: np.quantile(s, 0.5),
            p95=lambda s: np.quantile(s, 0.95),
        )
        if not trajectories.empty
        else pd.DataFrame(columns=["biomarker", "age", "mean", "p05", "p50", "p95"])
    )

    return {
        "trajectories": trajectories,
        "summary": summary,
        "boundary_log": boundaries,
    }


def _validate_single_state_model(
    process_model: BiomarkerProcessModel,
    df: pd.DataFrame,
    config: SimulationConfig,
) -> pd.DataFrame:
    biomarker = process_model.biomarker
    if process_model.mean_model is None:
        return pd.DataFrame()

    age_col = config.age_column
    weight_col = config.weight_column
    cont_covars, cat_covars = _assemble_covariate_columns(df, biomarker, config)

    work = df[[biomarker, age_col, weight_col, *cont_covars, *cat_covars]].copy()
    work[biomarker] = pd.to_numeric(work[biomarker], errors="coerce")
    work[age_col] = pd.to_numeric(work[age_col], errors="coerce")
    work[weight_col] = pd.to_numeric(work[weight_col], errors="coerce").fillna(0.0)
    work = work[(work[weight_col] > 0)].dropna(subset=[biomarker, age_col]).copy()

    if work.empty:
        return pd.DataFrame()

    ages = np.sort(work[age_col].unique())
    ages = ages[ages < ages.max()]

    rng = np.random.default_rng(config.random_seed + 313)

    rows: list[dict[str, float | str]] = []

    for age in ages:
        current = work[work[age_col] == age].copy()
        nxt = work[work[age_col] == age + 1].copy()

        if len(current) < config.validation_min_age_count or len(nxt) < config.validation_min_age_count:
            continue

        idx = _weighted_sample_indices(
            len(current),
            config.validation_particles_per_age,
            current[weight_col].to_numpy(dtype=float),
            rng,
        )
        sampled = current.iloc[idx].copy()

        x_t = sampled[biomarker].to_numpy(dtype=float)
        profiles = sampled.drop(columns=[biomarker, weight_col])

        x_next_sim, _ = _single_state_step(process_model, profiles, x_t, float(age), rng)

        obs_next = nxt[biomarker].to_numpy(dtype=float)
        obs_w = nxt[weight_col].to_numpy(dtype=float)

        var_sim = float(np.var(x_next_sim, ddof=0))
        var_obs = weighted_variance(obs_next, obs_w)

        wdist = weighted_wasserstein_distance(x_next_sim, obs_next, None, obs_w)
        rel_var_error = abs(var_sim - var_obs) / max(var_obs, config.epsilon)

        sim_mean = float(np.mean(x_next_sim))

        # Drift target in raw scale from model-predicted transformed mean.
        mu_t1_trans = _predict_mu_for_age(process_model.mean_model, profiles, age + 1.0, age_col)
        mu_t1_raw = _inverse_transform_values(mu_t1_trans, process_model.model_class, process_model.transform_params, epsilon=config.epsilon)
        mu_mean = float(np.mean(mu_t1_raw))
        drift_error = sim_mean - mu_mean

        ks_stat = float(ks_2samp(x_next_sim, obs_next).statistic)

        rows.append(
            {
                "age": float(age + 1),
                "age_bin": _age_bin_label(float(age + 1), config),
                "wasserstein": wdist,
                "ks_stat": ks_stat,
                "mean_diff": sim_mean - float(weighted_mean(obs_next, obs_w)),
                "std_diff": float(np.std(x_next_sim, ddof=0) - np.sqrt(max(var_obs, 0.0))),
                "variance_sim": var_sim,
                "variance_nhanes": var_obs,
                "variance_relative_error": rel_var_error,
                "variance_within_5pct": float(rel_var_error <= 0.05),
                "sim_mean": sim_mean,
                "mu_mean": mu_mean,
                "drift_error": drift_error,
            }
        )

    return pd.DataFrame(rows)


def _validate_lipid_model(
    process_model: BiomarkerProcessModel,
    df: pd.DataFrame,
    config: SimulationConfig,
) -> pd.DataFrame:
    biomarker = process_model.biomarker
    if process_model.regimes is None or process_model.transition_model is None:
        return pd.DataFrame()

    age_col = config.age_column
    weight_col = config.weight_column
    regime_col = "lipid_lowering_use"

    cont_covars, cat_covars = _assemble_covariate_columns(df, biomarker, config)
    cols = list(dict.fromkeys([biomarker, age_col, weight_col, regime_col, *cont_covars, *cat_covars]))
    work = df[cols].copy()
    work[biomarker] = pd.to_numeric(work[biomarker], errors="coerce")
    work[age_col] = pd.to_numeric(work[age_col], errors="coerce")
    work[weight_col] = pd.to_numeric(work[weight_col], errors="coerce").fillna(0.0)
    work[regime_col] = (pd.to_numeric(work[regime_col], errors="coerce").fillna(0.0) > 0).astype(int)
    work = work[(work[weight_col] > 0)].dropna(subset=[biomarker, age_col]).copy()

    if work.empty:
        return pd.DataFrame()

    ages = np.sort(work[age_col].unique())
    ages = ages[ages < ages.max()]

    rng = np.random.default_rng(config.random_seed + 587)

    rows: list[dict[str, float | str]] = []

    for age in ages:
        current = work[work[age_col] == age].copy()
        nxt = work[work[age_col] == age + 1].copy()

        if len(current) < config.validation_min_age_count or len(nxt) < config.validation_min_age_count:
            continue

        idx = _weighted_sample_indices(
            len(current),
            config.validation_particles_per_age,
            current[weight_col].to_numpy(dtype=float),
            rng,
        )
        sampled = current.iloc[idx].copy()

        x_t = sampled[biomarker].to_numpy(dtype=float)
        s_t = sampled[regime_col].to_numpy(dtype=int)

        prof = sampled.drop(columns=[biomarker, weight_col]).copy()
        prof_next = prof.copy()
        prof_next[age_col] = float(age + 1)

        p_on = process_model.transition_model.probability(prof_next, s_t.astype(float))
        s_next = rng.binomial(1, np.clip(p_on, 0.001, 0.999), size=len(sampled))

        x_next = np.zeros(len(sampled), dtype=float)
        mu_next_ref = np.zeros(len(sampled), dtype=float)

        for regime in (0, 1):
            ridx = np.where(s_next == regime)[0]
            if len(ridx) == 0:
                continue

            em = process_model.regimes[str(regime)]
            row_t = prof.iloc[ridx].copy()
            row_t[age_col] = float(age)
            row_t1 = prof.iloc[ridx].copy()
            row_t1[age_col] = float(age + 1)

            mu_t = em.mean_model.predict(row_t)
            mu_t1 = em.mean_model.predict(row_t1)
            sigma_t = em.variance_model.predict_sigma(row_t)
            kappa_t = em.kappa_result.kappa(np.full(len(ridx), float(age)))

            eps = rng.normal(size=len(ridx))
            alpha = mu_t1 - mu_t

            sim = x_t[ridx] + alpha - kappa_t * (x_t[ridx] - mu_t) + sigma_t * eps
            sim, _ = apply_reflective_bounds(sim, process_model.bounds[0], process_model.bounds[1])

            x_next[ridx] = sim
            mu_next_ref[ridx] = mu_t1

        obs_next = nxt[biomarker].to_numpy(dtype=float)
        obs_w = nxt[weight_col].to_numpy(dtype=float)

        var_sim = float(np.var(x_next, ddof=0))
        var_obs = weighted_variance(obs_next, obs_w)
        rel_var_error = abs(var_sim - var_obs) / max(var_obs, config.epsilon)

        sim_mean = float(np.mean(x_next))
        mu_mean = float(np.mean(mu_next_ref))
        drift_error = sim_mean - mu_mean

        wdist = weighted_wasserstein_distance(x_next, obs_next, None, obs_w)
        ks_stat = float(ks_2samp(x_next, obs_next).statistic)

        rows.append(
            {
                "age": float(age + 1),
                "age_bin": _age_bin_label(float(age + 1), config),
                "wasserstein": wdist,
                "ks_stat": ks_stat,
                "mean_diff": sim_mean - float(weighted_mean(obs_next, obs_w)),
                "std_diff": float(np.std(x_next, ddof=0) - np.sqrt(max(var_obs, 0.0))),
                "variance_sim": var_sim,
                "variance_nhanes": var_obs,
                "variance_relative_error": rel_var_error,
                "variance_within_5pct": float(rel_var_error <= 0.05),
                "sim_mean": sim_mean,
                "mu_mean": mu_mean,
                "drift_error": drift_error,
            }
        )

    return pd.DataFrame(rows)


def _plot_validation_diagnostics(result: ValidationResult, out_path: Path) -> None:
    df = result.per_age.sort_values("age")
    if df.empty:
        return

    fig, axes = plt.subplots(4, 1, figsize=(10, 13), sharex=True)

    axes[0].plot(df["age"], df["sim_mean"], label="Simulated mean", linewidth=2)
    axes[0].plot(df["age"], df["mu_mean"], label="Model mean", linewidth=2)
    axes[0].set_ylabel("Mean")
    axes[0].set_title(f"{result.biomarker}: Drift alignment")
    axes[0].legend(loc="best")

    axes[1].plot(df["age"], df["variance_sim"], label="Sim variance", linewidth=2)
    axes[1].plot(df["age"], df["variance_nhanes"], label="NHANES variance", linewidth=2)
    axes[1].set_ylabel("Variance")
    axes[1].legend(loc="best")

    axes[2].plot(df["age"], df["wasserstein"], color="tab:red", linewidth=2)
    axes[2].set_ylabel("Wasserstein")

    axes[3].plot(df["age"], df["ks_stat"], color="tab:purple", linewidth=2)
    axes[3].set_ylabel("KS")
    axes[3].set_xlabel("Age")

    fig.tight_layout()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def _plot_age_bin_distributions(
    process_model: BiomarkerProcessModel,
    df: pd.DataFrame,
    config: SimulationConfig,
    out_path: Path,
) -> None:
    biomarker = process_model.biomarker
    if process_model.mean_model is None and process_model.model_class != "lipid_regime":
        return

    age_col = config.age_column
    weight_col = config.weight_column

    cols = list(
        dict.fromkeys(
            [
                biomarker,
                age_col,
                weight_col,
                "lipid_lowering_use",
                "bmi",
                "pir",
                "statin_use",
                "sex",
                "race_ethnicity",
                "region_proxy",
                "height_cm",
            ]
        )
    )
    work = df[cols].copy()
    work[biomarker] = pd.to_numeric(work[biomarker], errors="coerce")
    work[age_col] = pd.to_numeric(work[age_col], errors="coerce")
    work[weight_col] = pd.to_numeric(work[weight_col], errors="coerce").fillna(0.0)
    work = work[(work[weight_col] > 0)].dropna(subset=[biomarker, age_col]).copy()
    if work.empty:
        return

    rng = np.random.default_rng(config.random_seed + 907)

    sim_by_bin: dict[str, np.ndarray] = {}
    obs_by_bin: dict[str, np.ndarray] = {}

    ages = np.sort(work[age_col].unique())
    ages = ages[ages < ages.max()]

    for age in ages:
        current = work[work[age_col] == age].copy()
        nxt = work[work[age_col] == age + 1].copy()
        if len(current) < config.validation_min_age_count or len(nxt) < config.validation_min_age_count:
            continue

        idx = _weighted_sample_indices(
            len(current),
            config.validation_particles_per_age,
            current[weight_col].to_numpy(dtype=float),
            rng,
        )
        sampled = current.iloc[idx].copy()

        bin_key = _age_bin_label(float(age + 1), config)

        if process_model.model_class == "lipid_regime":
            if process_model.regimes is None or process_model.transition_model is None:
                continue
            s_t = (pd.to_numeric(sampled["lipid_lowering_use"], errors="coerce").fillna(0.0) > 0).astype(int).to_numpy()
            prof = sampled.copy()
            prof_next = prof.copy()
            prof_next[age_col] = float(age + 1)

            p_on = process_model.transition_model.probability(prof_next, s_t.astype(float))
            s_next = rng.binomial(1, np.clip(p_on, 0.001, 0.999), size=len(sampled))

            x_sim = np.zeros(len(sampled), dtype=float)
            for regime in (0, 1):
                ridx = np.where(s_next == regime)[0]
                if len(ridx) == 0:
                    continue
                em = process_model.regimes[str(regime)]
                row_t = prof.iloc[ridx].copy()
                row_t[age_col] = float(age)
                row_t1 = prof.iloc[ridx].copy()
                row_t1[age_col] = float(age + 1)

                mu_t = em.mean_model.predict(row_t)
                mu_t1 = em.mean_model.predict(row_t1)
                sigma_t = em.variance_model.predict_sigma(row_t)
                kappa_t = em.kappa_result.kappa(np.full(len(ridx), float(age)))
                eps = rng.normal(size=len(ridx))
                alpha = mu_t1 - mu_t
                sim = sampled.iloc[ridx][biomarker].to_numpy(dtype=float) + alpha - kappa_t * (sampled.iloc[ridx][biomarker].to_numpy(dtype=float) - mu_t) + sigma_t * eps
                sim, _ = apply_reflective_bounds(sim, process_model.bounds[0], process_model.bounds[1])
                x_sim[ridx] = sim
        else:
            prof = sampled.drop(columns=[biomarker, weight_col])
            x_t = sampled[biomarker].to_numpy(dtype=float)
            x_sim, _ = _single_state_step(process_model, prof, x_t, float(age), rng)

        sim_by_bin.setdefault(bin_key, np.array([], dtype=float))
        obs_by_bin.setdefault(bin_key, np.array([], dtype=float))

        sim_by_bin[bin_key] = np.concatenate([sim_by_bin[bin_key], x_sim])
        obs_by_bin[bin_key] = np.concatenate([obs_by_bin[bin_key], nxt[biomarker].to_numpy(dtype=float)])

    bins = sorted(sim_by_bin.keys())
    if not bins:
        return

    n_cols = 3
    n_rows = int(math.ceil(len(bins) / n_cols))
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(4.8 * n_cols, 3.2 * n_rows), squeeze=False)

    for i, bin_key in enumerate(bins):
        ax = axes[i // n_cols][i % n_cols]
        sim = sim_by_bin[bin_key]
        obs = obs_by_bin[bin_key]
        if len(sim) == 0 or len(obs) == 0:
            ax.axis("off")
            continue

        low = float(min(np.quantile(sim, 0.01), np.quantile(obs, 0.01)))
        high = float(max(np.quantile(sim, 0.99), np.quantile(obs, 0.99)))
        if high <= low:
            low, high = float(min(sim.min(), obs.min())), float(max(sim.max(), obs.max()))
            if high <= low:
                high = low + 1.0

        bins_hist = np.linspace(low, high, 26)
        ax.hist(obs, bins=bins_hist, density=True, alpha=0.45, color="#4e9ecf", label="NHANES")
        ax.hist(sim, bins=bins_hist, density=True, alpha=0.45, color="#d97349", label="Sim")
        ax.set_title(bin_key)

    for j in range(len(bins), n_rows * n_cols):
        axes[j // n_cols][j % n_cols].axis("off")

    handles, labels = axes[0][0].get_legend_handles_labels()
    if handles:
        fig.legend(handles, labels, loc="upper right")

    fig.suptitle(f"{biomarker}: simulated vs NHANES by age bin", y=0.995)
    fig.tight_layout(rect=(0, 0, 1, 0.97))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def validate_model(
    process_model: BiomarkerProcessModel,
    df: pd.DataFrame,
    config: SimulationConfig,
    output_dir: Path | None = None,
) -> ValidationResult:
    """Run validation diagnostics against NHANES age-bin distributions."""

    if process_model.model_class == "lipid_regime":
        per_age = _validate_lipid_model(process_model, df, config)
    else:
        per_age = _validate_single_state_model(process_model, df, config)

    if per_age.empty:
        return ValidationResult(
            biomarker=process_model.biomarker,
            per_age=per_age,
            mean_wasserstein=np.nan,
            variance_pass_rate=np.nan,
            drift_rmse=np.nan,
            mean_model_rmse=process_model.mean_model_rmse,
            ks_mean=np.nan,
            overall_score=np.nan,
        )

    grouped = per_age.groupby("age_bin", as_index=False).agg(
        wasserstein=("wasserstein", "mean"),
        ks_stat=("ks_stat", "mean"),
        variance_within_5pct=("variance_within_5pct", "mean"),
    )

    mean_wdist = float(grouped["wasserstein"].mean())
    ks_mean = float(grouped["ks_stat"].mean())
    var_pass = float(grouped["variance_within_5pct"].mean())
    drift_rmse = float(np.sqrt(np.mean(np.square(per_age["drift_error"].to_numpy(dtype=float)))))

    overall_score = (
        config.score_wasserstein * mean_wdist
        + config.score_mean_rmse * float(_safe_float(process_model.mean_model_rmse, np.nan))
        + config.score_drift_rmse * drift_rmse
        + config.score_variance_penalty * (1.0 - var_pass)
    )

    result = ValidationResult(
        biomarker=process_model.biomarker,
        per_age=per_age,
        mean_wasserstein=mean_wdist,
        variance_pass_rate=var_pass,
        drift_rmse=drift_rmse,
        mean_model_rmse=process_model.mean_model_rmse,
        ks_mean=ks_mean,
        overall_score=overall_score,
    )

    if output_dir is not None:
        output_dir.mkdir(parents=True, exist_ok=True)
        _plot_validation_diagnostics(result, output_dir / f"{process_model.biomarker}_validation.png")
        _plot_age_bin_distributions(process_model, df, config, output_dir / f"{process_model.biomarker}_agebin_distribution.png")

    return result


def fit_all_biomarker_models(
    df: pd.DataFrame,
    config: SimulationConfig,
    biomarkers: list[str] | None = None,
) -> dict[str, BiomarkerProcessModel]:
    selected = biomarkers if biomarkers is not None else [b for b in BIOMARKERS if b in df.columns]

    models: dict[str, BiomarkerProcessModel] = {}

    lipid_selected = [b for b in selected if b in LIPID_BIOMARKERS and b in df.columns]
    if lipid_selected:
        lipid_models = _fit_lipid_regime_bundle(df, config, list(LIPID_BIOMARKERS))
        for b in lipid_selected:
            models[b] = lipid_models[b]

    for biomarker in selected:
        if biomarker in models:
            continue
        if biomarker not in df.columns:
            continue

        if biomarker in LIPID_BIOMARKERS:
            continue

        bounds = DEFAULT_BOUNDS.get(biomarker)
        model = fit_biomarker_process(df, biomarker, config, bounds=bounds)
        models[biomarker] = model

    return models


def validate_all_models(
    models: Mapping[str, BiomarkerProcessModel],
    df: pd.DataFrame,
    config: SimulationConfig,
    output_dir: Path,
) -> dict[str, ValidationResult]:
    output_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, ValidationResult] = {}

    for biomarker, model in models.items():
        results[biomarker] = validate_model(model, df, config, output_dir=output_dir)

    return results


def _serialize_process_models(models: Mapping[str, BiomarkerProcessModel]) -> dict[str, dict[str, Any]]:
    return {biomarker: asdict(model) for biomarker, model in models.items()}


def _restore_design_state(payload: Mapping[str, Any]) -> DesignMatrixState:
    d = dict(payload)
    d.setdefault("age_median", 50.0)
    return DesignMatrixState(**d)


def _restore_mean_model(payload: Mapping[str, Any] | None) -> ConditionalMeanModel | None:
    if payload is None:
        return None
    d = dict(payload)
    return ConditionalMeanModel(
        biomarker=d["biomarker"],
        state=_restore_design_state(d["state"]),
        coefficients=np.asarray(d["coefficients"], dtype=float),
        ridge_alpha=float(d["ridge_alpha"]),
        n_obs=int(d["n_obs"]),
        weighted_rmse=float(d["weighted_rmse"]),
    )


def _restore_variance_model(payload: Mapping[str, Any] | None) -> VarianceModel | None:
    if payload is None:
        return None
    d = dict(payload)
    return VarianceModel(
        biomarker=d["biomarker"],
        state=_restore_design_state(d["state"]),
        coefficients=np.asarray(d["coefficients"], dtype=float),
        ridge_alpha=float(d["ridge_alpha"]),
        variance_floor=float(d["variance_floor"]),
        n_obs=int(d["n_obs"]),
    )


def _restore_kappa(payload: Mapping[str, Any] | None) -> KappaCalibrationResult | None:
    if payload is None:
        return None
    d = dict(payload)
    return KappaCalibrationResult(
        biomarker=d["biomarker"],
        kappa0=float(d["kappa0"]),
        kappa_age=float(d["kappa_age"]),
        age_reference=float(d["age_reference"]),
        kappa_floor=float(d["kappa_floor"]),
        kappa_ceiling=float(d["kappa_ceiling"]),
        objective_value=float(d["objective_value"]),
        calibration_table=pd.DataFrame(d["calibration_table"]),
    )


def _restore_transition_model(payload: Mapping[str, Any] | None) -> TransitionModel | None:
    if payload is None:
        return None
    d = dict(payload)
    state = TransitionDesignState(**d["state"])
    return TransitionModel(
        state=state,
        coefficients=np.asarray(d["coefficients"], dtype=float),
        intercept=float(d["intercept"]),
        persistence_coef=float(d["persistence_coef"]),
    )


def _deserialize_process_models(payload: Mapping[str, Mapping[str, Any]]) -> dict[str, BiomarkerProcessModel]:
    restored: dict[str, BiomarkerProcessModel] = {}

    for biomarker, model_dict in payload.items():
        mean_model = _restore_mean_model(model_dict.get("mean_model"))
        variance_model = _restore_variance_model(model_dict.get("variance_model"))
        kappa = _restore_kappa(model_dict.get("kappa_result"))

        regimes_payload = model_dict.get("regimes")
        regimes: dict[str, RegimeEmissionModel] | None = None
        if regimes_payload is not None:
            regimes = {}
            for key, reg_payload in regimes_payload.items():
                reg_payload = dict(reg_payload)
                regimes[key] = RegimeEmissionModel(
                    mean_model=_restore_mean_model(reg_payload.get("mean_model")),
                    variance_model=_restore_variance_model(reg_payload.get("variance_model")),
                    kappa_result=_restore_kappa(reg_payload.get("kappa_result")),
                    n_obs=int(reg_payload.get("n_obs", 0)),
                )

        regime_corr_payload = model_dict.get("regime_corr")
        regime_corr: dict[str, np.ndarray] | None = None
        if regime_corr_payload is not None:
            regime_corr = {str(k): np.asarray(v, dtype=float) for k, v in regime_corr_payload.items()}

        restored[biomarker] = BiomarkerProcessModel(
            biomarker=model_dict["biomarker"],
            model_class=model_dict["model_class"],
            bounds=tuple(model_dict["bounds"]),
            mean_model=mean_model,
            variance_model=variance_model,
            kappa_result=kappa,
            transform_params=model_dict.get("transform_params"),
            regimes=regimes,
            transition_model=_restore_transition_model(model_dict.get("transition_model")),
            regime_corr=regime_corr,
            lipid_order=tuple(model_dict.get("lipid_order")) if model_dict.get("lipid_order") is not None else None,
            mean_model_rmse=float(model_dict.get("mean_model_rmse", np.nan)),
            n_obs=int(model_dict.get("n_obs", 0)),
        )

    return restored


def save_process_models(models: Mapping[str, BiomarkerProcessModel], out_path: Path) -> None:
    serialized = _serialize_process_models(models)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(serialized, out_path)


def load_process_models(path: Path) -> dict[str, BiomarkerProcessModel]:
    payload = joblib.load(path)
    if not isinstance(payload, dict):
        raise TypeError("Expected serialized process model payload to be a dict")
    return _deserialize_process_models(payload)


def write_technical_summary(
    models: Mapping[str, BiomarkerProcessModel],
    validations: Mapping[str, ValidationResult],
    output_path: Path,
) -> None:
    lines: list[str] = []
    lines.append("# Stage 1 Biomarker Simulation Technical Summary")
    lines.append("")
    lines.append("## Model Classes")
    lines.append("- Default biomarkers: Gaussian OU with age spline mean and heteroskedastic variance.")
    lines.append("- CRP: log(1 + CRP) OU to handle right-skewed tails.")
    lines.append("- LDL/HDL/Total cholesterol: medication-aware regime-switching OU with correlated innovations.")
    lines.append("- eGFR: bounded-logit OU with upper bound chosen from {120, 130} via validation score.")
    lines.append("")
    lines.append("## Validation Metrics")
    lines.append("- Mean Wasserstein distance by age bin.")
    lines.append("- Variance pass rate (share of age bins within +/-5% variance error).")
    lines.append("- Drift RMSE (simulated mean vs model mean).")
    lines.append("- KS statistic (reported in per-age diagnostics CSVs).")
    lines.append("")
    lines.append("## Biomarker Results")
    lines.append("| biomarker | model_class | kappa0 | kappa_age | objective | mean_wasserstein | variance_pass_rate | drift_rmse | mean_model_rmse |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|")

    for biomarker in sorted(models.keys()):
        model = models[biomarker]
        val = validations.get(biomarker)
        kappa = model.kappa_result
        lines.append(
            "| {b} | {mc} | {k0:.4f} | {ka:.4f} | {obj:.6f} | {wd:.6f} | {vp:.3f} | {dr:.6f} | {rmse:.6f} |".format(
                b=biomarker,
                mc=model.model_class,
                k0=np.nan if kappa is None else kappa.kappa0,
                ka=np.nan if kappa is None else kappa.kappa_age,
                obj=np.nan if kappa is None else kappa.objective_value,
                wd=np.nan if val is None else val.mean_wasserstein,
                vp=np.nan if val is None else val.variance_pass_rate,
                dr=np.nan if val is None else val.drift_rmse,
                rmse=model.mean_model_rmse,
            )
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + "\n")


def write_changelog(models: Mapping[str, BiomarkerProcessModel], path: Path) -> None:
    lines = [
        "# CHANGELOG",
        "",
        "## Stage 1 Biomarker Simulator Upgrade",
        "",
        "- Added NHANES RXQ_RX ingestion and merged person-level indicators: `statin_use`, `lipid_lowering_use`.",
        "- Implemented robust ingredient-name heuristics for lipid medications when full class lookup is unavailable.",
        "- Added per-biomarker model-class table and specialized model families:",
        "  - `crp`: log-scale OU (right-skew handling).",
        "  - `ldl`, `hdl`, `total_cholesterol`: regime-switching medication-aware OU + correlated innovations.",
        "  - `egfr`: bounded-logit OU with upper-bound model selection (120 vs 130).",
        "- Extended validation with age-bin Wasserstein, KS, mean/std gaps, drift RMSE, and variance pass rate.",
        "",
        "## Active Model Class Map",
    ]

    for biomarker in sorted(models.keys()):
        lines.append(f"- `{biomarker}` -> `{models[biomarker].model_class}`")

    path.write_text("\n".join(lines) + "\n")


def load_nhanes_dataset(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"NHANES dataset not found: {path}")

    df = pd.read_csv(path)
    required = {"age", "sample_weight", "sex", "race_ethnicity"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"Dataset missing required columns: {missing}")

    raw_root = Path(__file__).resolve().parent / "data" / "raw"
    if raw_root.exists():
        df = _add_rx_indicators(df, raw_root)
    else:
        med = pd.to_numeric(df.get("medication_use", 0.0), errors="coerce").fillna(0.0)
        df["statin_use"] = (med > 0).astype(float)
        df["lipid_lowering_use"] = (med > 0).astype(float)

    # Ensure expected covariate columns exist.
    for col in [
        "bmi",
        "pir",
        "height_cm",
        "creatinine",
        "region_proxy",
        "sex",
        "race_ethnicity",
        "statin_use",
        "lipid_lowering_use",
    ]:
        if col not in df.columns:
            df[col] = np.nan

    return df


def run_stage1_pipeline(
    data_path: Path,
    output_dir: Path,
    biomarkers: list[str] | None = None,
    random_seed: int = 42,
) -> dict[str, Any]:
    config = SimulationConfig(random_seed=random_seed)

    df = load_nhanes_dataset(data_path)

    models = fit_all_biomarker_models(df, config=config, biomarkers=biomarkers)

    diagnostics_dir = output_dir / "diagnostics"
    validations = validate_all_models(models, df, config, diagnostics_dir)

    output_dir.mkdir(parents=True, exist_ok=True)

    save_process_models(models, output_dir / "stage1_biomarker_models.joblib")

    summary_rows: list[dict[str, Any]] = []
    for biomarker, model in models.items():
        val = validations[biomarker]
        kappa = model.kappa_result

        summary_rows.append(
            {
                "biomarker": biomarker,
                "kappa0": np.nan if kappa is None else kappa.kappa0,
                "kappa_age": np.nan if kappa is None else kappa.kappa_age,
                "objective": np.nan if kappa is None else kappa.objective_value,
                "mean_wasserstein": val.mean_wasserstein,
                "variance_pass_rate": val.variance_pass_rate,
                "drift_rmse": val.drift_rmse,
                "mean_model_rmse": model.mean_model_rmse,
                "n_obs": model.n_obs,
                "model_class": model.model_class,
                "ks_mean": val.ks_mean,
                "overall_score": val.overall_score,
            }
        )

        if kappa is not None:
            kappa.calibration_table.to_csv(output_dir / f"{biomarker}_kappa_calibration.csv", index=False)
        val.per_age.to_csv(output_dir / f"{biomarker}_validation_by_age.csv", index=False)

    summary_df = pd.DataFrame(summary_rows).sort_values("biomarker")
    summary_df.to_csv(output_dir / "stage1_validation_summary.csv", index=False)

    write_technical_summary(models, validations, output_dir / "TECHNICAL_SUMMARY.md")
    write_changelog(models, output_dir / "CHANGELOG.md")

    # Also keep a project-level changelog in ML/ for quick lookup.
    project_changelog = Path(__file__).resolve().parent / "CHANGELOG.md"
    write_changelog(models, project_changelog)

    manifest = {
        "data_path": str(data_path),
        "output_dir": str(output_dir),
        "n_biomarkers": len(models),
        "biomarkers": sorted(models.keys()),
        "model_artifact": str(output_dir / "stage1_biomarker_models.joblib"),
        "summary_csv": str(output_dir / "stage1_validation_summary.csv"),
        "technical_summary": str(output_dir / "TECHNICAL_SUMMARY.md"),
        "changelog": str(output_dir / "CHANGELOG.md"),
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    return manifest


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage 1 biomarker simulation engine")
    parser.add_argument(
        "--data",
        type=Path,
        default=Path("outputs/cleaned/nhanes_2011_2018_merged_cleaned.csv.gz"),
        help="Path to pooled NHANES dataset",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("outputs/stage1_biomarker_simulation"),
        help="Output directory for fitted models and diagnostics",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed",
    )
    parser.add_argument(
        "--biomarkers",
        nargs="*",
        default=None,
        help="Optional subset of biomarkers",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    manifest = run_stage1_pipeline(
        data_path=args.data,
        output_dir=args.out,
        biomarkers=args.biomarkers,
        random_seed=args.seed,
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
