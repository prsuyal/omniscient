#!/usr/bin/env python3
"""Functional model test harness for requested NHANES models.

This script goes beyond AUC and creates:
1) threshold-based confusion metrics
2) risk decile lift checks
3) low vs high-risk scenario predictions
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import precision_score, recall_score

from simulation_engine import DiseaseRiskEngine
from hearing_data import CYCLES, build_hearing_analysis_dataset, merge_cycle


ROOT = Path("/Users/pranshusuyal/Downloads/codexdata")
OUTPUTS = ROOT / "outputs"
TEST_DIR = OUTPUTS / "testing"

CLASSIC_MODELS = [
    "arthritis",
    "mobility_limitation",
    "cognitive_decline",
    "cardiovascular_disease",
    "chronic_kidney_disease",
    "liver_disease",
    "cancer_any",
]


def patch_bspline_compat() -> None:
    # Older pickled SplineTransformer objects may contain scipy BSpline instances
    # exposing `_c` but not `c`, while newer sklearn expects `.c`.
    try:
        from scipy.interpolate import BSpline
    except Exception:
        return

    def _get_coef(self: Any) -> Any:
        if hasattr(self, "_c"):
            return self._c
        return object.__getattribute__(self, "__dict__").get("c")

    def _get_knots(self: Any) -> Any:
        if hasattr(self, "_t"):
            return self._t
        return object.__getattribute__(self, "__dict__").get("t")

    if not hasattr(BSpline, "c"):
        BSpline.c = property(_get_coef)  # type: ignore[attr-defined]
    if not hasattr(BSpline, "t"):
        BSpline.t = property(_get_knots)  # type: ignore[attr-defined]


def weighted_confusion(y: np.ndarray, pred: np.ndarray, w: np.ndarray) -> Dict[str, float]:
    tp = float(np.sum(w[(y == 1) & (pred == 1)]))
    fp = float(np.sum(w[(y == 0) & (pred == 1)]))
    tn = float(np.sum(w[(y == 0) & (pred == 0)]))
    fn = float(np.sum(w[(y == 1) & (pred == 0)]))
    return {"tp_w": tp, "fp_w": fp, "tn_w": tn, "fn_w": fn}


def choose_threshold(y: np.ndarray, p: np.ndarray, w: np.ndarray) -> float:
    best_t = 0.5
    best_score = -1.0
    for t in np.arange(0.05, 0.96, 0.05):
        pred = (p >= t).astype(int)
        if pred.sum() == 0:
            continue
        prec = precision_score(y, pred, zero_division=0)
        rec = recall_score(y, pred, zero_division=0)
        score = 2 * prec * rec / max(1e-9, (prec + rec))
        if score > best_score:
            best_score = score
            best_t = float(t)
    return best_t


def classic_design(bundle: Dict[str, Any], df: pd.DataFrame) -> pd.DataFrame:
    st = bundle["preprocess"]
    cont = bundle["continuous_features"]
    binary = bundle["binary_features"]
    cats = bundle["categorical_features"]
    work = df.copy()

    miss = pd.DataFrame(index=work.index)
    cont_scaled = pd.DataFrame(index=work.index)
    for c in cont:
        s = pd.to_numeric(work[c], errors="coerce")
        miss[f"{c}__missing"] = s.isna().astype(float)
        f = s.fillna(float(st["medians"][c]))
        cont_scaled[c] = (f - float(st["means"][c])) / float(st["stds"][c])

    age_filled = pd.to_numeric(work["age"], errors="coerce").fillna(float(st["medians"]["age"]))
    spline_values = st["spline_transformer"].transform(age_filled.to_numpy().reshape(-1, 1))
    spline = pd.DataFrame(spline_values, index=work.index, columns=st["spline_columns"])

    cat = pd.DataFrame(index=work.index)
    for c in cats:
        cat[c] = work[c].fillna("Unknown").astype(str)
    dummies = pd.get_dummies(cat, prefix=cats, dummy_na=False, dtype=float)
    dummies = dummies.reindex(columns=st["dummy_columns"], fill_value=0.0)

    bin_df = pd.DataFrame(index=work.index)
    for b in binary:
        bin_df[b] = pd.to_numeric(work[b], errors="coerce").fillna(0.0)

    sex_male = dummies["sex_Male"] if "sex_Male" in dummies.columns else pd.Series(0.0, index=work.index)
    inter = pd.DataFrame(index=work.index)
    inter["age_x_bmi"] = cont_scaled["age"] * cont_scaled["bmi"]
    inter["age_x_smoking"] = cont_scaled["age"] * bin_df["current_smoker"]
    inter["sex_x_bmi"] = sex_male * cont_scaled["bmi"]

    X = pd.concat([spline, cont_scaled.drop(columns=["age"]), miss, bin_df, dummies, inter], axis=1)
    return X.reindex(columns=st["final_columns"], fill_value=0.0)


def hearing_design(bundle: Dict[str, Any], df: pd.DataFrame) -> pd.DataFrame:
    st = bundle["state"]
    cont = bundle["continuous_cols"]
    binary = bundle["binary_cols"]
    cats = bundle["categorical_cols"]
    work = df.copy()

    miss = pd.DataFrame(index=work.index)
    cont_scaled = pd.DataFrame(index=work.index)
    for c in cont:
        s = pd.to_numeric(work[c], errors="coerce")
        miss[f"{c}__missing"] = s.isna().astype(float)
        f = s.fillna(float(st["medians"][c]))
        cont_scaled[c] = (f - float(st["means"][c])) / float(st["stds"][c])

    age_filled = pd.to_numeric(work["age"], errors="coerce").fillna(float(st["medians"]["age"]))
    spline_values = st["spline_transformer"].transform(age_filled.to_numpy().reshape(-1, 1))
    spline = pd.DataFrame(spline_values, index=work.index, columns=st["spline_columns"])

    cat = pd.DataFrame(index=work.index)
    for c in cats:
        cat[c] = work[c].fillna("Unknown").astype(str)
    dummies = pd.get_dummies(cat, prefix=cats, dummy_na=False, dtype=float)
    dummies = dummies.reindex(columns=st["dummy_columns"], fill_value=0.0)

    bin_df = pd.DataFrame(index=work.index)
    for b in binary:
        bin_df[b] = pd.to_numeric(work[b], errors="coerce").fillna(0.0)

    sex_male = dummies["sex_Male"] if "sex_Male" in dummies.columns else pd.Series(0.0, index=work.index)
    inter = pd.DataFrame(index=work.index)
    inter["age_x_bmi"] = cont_scaled["age"] * cont_scaled["bmi"]
    inter["age_x_smoking"] = cont_scaled["age"] * bin_df["current_smoker"]
    inter["sex_x_bmi"] = sex_male * cont_scaled["bmi"]

    X = pd.concat([spline, cont_scaled.drop(columns=["age"]), miss, bin_df, dummies, inter], axis=1)
    return X.reindex(columns=st["final_columns"], fill_value=0.0)


def evaluate_from_predictions(name: str, y: np.ndarray, p: np.ndarray, w: np.ndarray) -> Dict[str, Any]:
    thr = choose_threshold(y, p, w)
    pred = (p >= thr).astype(int)
    conf = weighted_confusion(y, pred, w)

    q90 = np.quantile(p, 0.9)
    top = p >= q90
    top_prev = float(np.average(y[top], weights=w[top])) if top.any() else np.nan
    base_prev = float(np.average(y, weights=w))

    return {
        "model": name,
        "n": int(len(y)),
        "weighted_prevalence": base_prev,
        "mean_predicted_risk": float(np.average(p, weights=w)),
        "selected_threshold": thr,
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "top_decile_prevalence": top_prev,
        "top_decile_lift": float(top_prev / base_prev) if base_prev > 0 else np.nan,
        **conf,
    }


def load_hearing_dataset() -> pd.DataFrame:
    cached = OUTPUTS / "cleaned" / "hearing_analysis_dataset.csv.gz"
    if cached.exists():
        return pd.read_csv(cached)

    raw_dir = ROOT / "data" / "raw"
    frames = [merge_cycle(raw_dir, cyc, ["DEMO", "BMX", "BPX", "HDL", "TRIGLY", "TCHOL", "GHB", "BIOPRO", "HSCRP", "SMQ", "BPQ", "DIQ", "MCQ", "PFQ", "AUX", "AUQ"]) for cyc in CYCLES]
    merged = pd.concat(frames, ignore_index=True, sort=False)
    out = build_hearing_analysis_dataset(merged)
    cached.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(cached, index=False, compression="gzip")
    return out


def main() -> None:
    patch_bspline_compat()
    TEST_DIR.mkdir(parents=True, exist_ok=True)

    summary_rows: List[Dict[str, Any]] = []
    scenario_rows: List[Dict[str, Any]] = []

    # Real-data functional testing for the classic 7 outcomes.
    df = pd.read_csv(OUTPUTS / "cleaned" / "nhanes_2011_2018_merged_cleaned.csv.gz")
    df = df[df["age"] >= 20].copy()
    df["sample_weight"] = pd.to_numeric(df["sample_weight"], errors="coerce")
    df = df[df["sample_weight"] > 0].copy()

    engine = DiseaseRiskEngine(ROOT / "outputs" / "models")

    for disease in CLASSIC_MODELS:
        bundle = joblib.load(OUTPUTS / "models" / f"{disease}.joblib")
        eval_df = df[df[disease].notna()].copy()
        X = classic_design(bundle, eval_df)
        p = bundle["model"].predict_proba(X)[:, 1]
        y = eval_df[disease].astype(int).to_numpy()
        w = eval_df["sample_weight"].to_numpy(dtype=float)
        summary_rows.append(evaluate_from_predictions(disease, y, p, w))

        top = eval_df.assign(pred=p).sort_values("pred", ascending=False).head(25)
        top[["seqn", "age", "sex", "race_ethnicity", disease, "pred"]].to_csv(TEST_DIR / f"{disease}_top25.csv", index=False)

        low = {
            "bmi": 23,
            "hdl": 62,
            "ldl": 95,
            "total_cholesterol": 175,
            "systolic_bp": 112,
            "diastolic_bp": 72,
            "resting_hr": 65,
            "hba1c": 5.3,
            "egfr": 105,
            "crp": 0.8,
            "height_cm": 170,
            "pir": 3.5,
            "sleep_hours": 7.5,
            "diet_quality_indicator": 2,
            "alcohol_drinks_per_day": 0.0,
            "pa_minutes_week": 220,
            "current_smoker": 0,
            "former_smoker": 0,
            "alcohol_use": 0,
            "physically_active": 1,
            "medication_use": 0,
            "family_history_heart": 0,
            "family_history_asthma": 0,
            "family_history_diabetes": 0,
            "pre_hypertension": 0,
            "pre_diabetes": 0,
            "sex": "Female",
            "race_ethnicity": "Non-Hispanic White",
            "region_proxy": "Unknown",
        }
        high = {
            "bmi": 36,
            "hdl": 34,
            "ldl": 165,
            "total_cholesterol": 265,
            "systolic_bp": 156,
            "diastolic_bp": 96,
            "resting_hr": 86,
            "hba1c": 8.4,
            "egfr": 45,
            "crp": 6.0,
            "height_cm": 170,
            "pir": 0.9,
            "sleep_hours": 5.0,
            "diet_quality_indicator": 0,
            "alcohol_drinks_per_day": 2.0,
            "pa_minutes_week": 0,
            "current_smoker": 1,
            "former_smoker": 0,
            "alcohol_use": 1,
            "physically_active": 0,
            "medication_use": 1,
            "family_history_heart": 1,
            "family_history_asthma": 1,
            "family_history_diabetes": 1,
            "pre_hypertension": 1,
            "pre_diabetes": 1,
            "sex": "Male",
            "race_ethnicity": "Non-Hispanic Black",
            "region_proxy": "Unknown",
        }
        p_low_40 = engine.predict_prevalence(disease, 40, low)
        p_low_70 = engine.predict_prevalence(disease, 70, low)
        p_high_40 = engine.predict_prevalence(disease, 40, high)
        p_high_70 = engine.predict_prevalence(disease, 70, high)
        scenario_rows.append(
            {
                "model": disease,
                "low_age40": p_low_40,
                "low_age70": p_low_70,
                "high_age40": p_high_40,
                "high_age70": p_high_70,
                "delta_high70_minus_low40": p_high_70 - p_low_40,
            }
        )

    # Hearing loss functional test.
    h_bundle = joblib.load(OUTPUTS / "models" / "hearing_loss_model.joblib")
    hearing_df = load_hearing_dataset()
    hearing_df = hearing_df[(hearing_df["hearing_loss"].notna()) & (hearing_df["sample_weight"] > 0)].copy()
    Xh = hearing_design(h_bundle, hearing_df)
    ph = h_bundle["model"].predict_proba(Xh)[:, 1]
    yh = hearing_df["hearing_loss"].astype(int).to_numpy()
    wh = hearing_df["sample_weight"].to_numpy(dtype=float)
    summary_rows.append(evaluate_from_predictions("hearing_loss", yh, ph, wh))
    top_h = hearing_df.assign(pred=ph).sort_values("pred", ascending=False).head(25)
    top_h[["seqn", "age", "sex", "race_ethnicity", "hearing_loss", "pred"]].to_csv(TEST_DIR / "hearing_loss_top25.csv", index=False)

    h_low = {
        "bmi": 23,
        "systolic_bp": 112,
        "diastolic_bp": 72,
        "total_cholesterol": 175,
        "hdl": 62,
        "ldl": 95,
        "hba1c": 5.3,
        "egfr": 105,
        "crp": 0.8,
        "pir": 3.5,
        "current_smoker": 0,
        "diabetes": 0,
        "bp_treated": 0,
        "lipid_med": 0,
        "sex": "Female",
        "race_ethnicity": "Non-Hispanic White",
    }
    h_high = {
        "bmi": 35,
        "systolic_bp": 156,
        "diastolic_bp": 96,
        "total_cholesterol": 255,
        "hdl": 34,
        "ldl": 165,
        "hba1c": 8.1,
        "egfr": 45,
        "crp": 6.0,
        "pir": 0.9,
        "current_smoker": 1,
        "diabetes": 1,
        "bp_treated": 1,
        "lipid_med": 1,
        "sex": "Male",
        "race_ethnicity": "Non-Hispanic Black",
    }
    h_low_40 = float(h_bundle["model"].predict_proba(hearing_design(h_bundle, pd.DataFrame([{**h_low, "age": 40}])))[:, 1][0])
    h_low_70 = float(h_bundle["model"].predict_proba(hearing_design(h_bundle, pd.DataFrame([{**h_low, "age": 70}])))[:, 1][0])
    h_high_40 = float(h_bundle["model"].predict_proba(hearing_design(h_bundle, pd.DataFrame([{**h_high, "age": 40}])))[:, 1][0])
    h_high_70 = float(h_bundle["model"].predict_proba(hearing_design(h_bundle, pd.DataFrame([{**h_high, "age": 70}])))[:, 1][0])
    scenario_rows.append(
        {
            "model": "hearing_loss",
            "low_age40": h_low_40,
            "low_age70": h_low_70,
            "high_age40": h_high_40,
            "high_age70": h_high_70,
            "delta_high70_minus_low40": h_high_70 - h_low_40,
        }
    )

    summary = pd.DataFrame(summary_rows).sort_values("model")
    scenarios = pd.DataFrame(scenario_rows).sort_values("model")

    summary.to_csv(TEST_DIR / "model_functional_summary.csv", index=False)
    scenarios.to_csv(TEST_DIR / "scenario_predictions.csv", index=False)

    report = {
        "summary_csv": str(TEST_DIR / "model_functional_summary.csv"),
        "scenarios_csv": str(TEST_DIR / "scenario_predictions.csv"),
        "top_cases_dir": str(TEST_DIR),
        "models_tested": sorted([*CLASSIC_MODELS, "hearing_loss"]),
    }
    (TEST_DIR / "functional_test_manifest.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
