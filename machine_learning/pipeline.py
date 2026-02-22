#!/usr/bin/env python3
"""NHANES Vision/Hearing + PCE + ARIC (logistic-style) pipeline.

Implements the original modeling style:
- weighted logistic prevalence models for NHANES outcomes
- 5-fold stratified CV
- AUC, calibration, Brier
- no survival modeling for NHANES
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import joblib
import matplotlib
import numpy as np
import pandas as pd
import requests
import yaml
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import SplineTransformer

matplotlib.use("Agg")
import matplotlib.pyplot as plt

3
CYCLES = [
    {"label": "2011-2012", "year": 2011, "suffix": "G"},
    {"label": "2013-2014", "year": 2013, "suffix": "H"},
    {"label": "2015-2016", "year": 2015, "suffix": "I"},
    {"label": "2017-2018", "year": 2017, "suffix": "J"},
]

NHANES_FILE_CODES = [
    "DEMO",
    "BMX",
    "BPX",
    "HDL",
    "TRIGLY",
    "TCHOL",
    "GHB",
    "BIOPRO",
    "HSCRP",
    "SMQ",
    "BPQ",
    "DIQ",
    "MCQ",
    "PFQ",
    "AUX",
    "AUQ",
]


@dataclass
class PreprocessState:
    medians: Dict[str, float]
    means: Dict[str, float]
    stds: Dict[str, float]
    dummy_columns: List[str]
    final_columns: List[str]
    spline_transformer: Any
    spline_columns: List[str]


def safe_float(x: Any, default: float = np.nan) -> float:
    try:
        v = float(x)
    except Exception:
        return default
    if not np.isfinite(v):
        return default
    return v


def safe_col(df: pd.DataFrame, col: str) -> pd.Series:
    if col in df.columns:
        return pd.to_numeric(df[col], errors="coerce")
    return pd.Series(np.nan, index=df.index)


def coalesce_numeric(df: pd.DataFrame, cols: Iterable[str]) -> pd.Series:
    out = pd.Series(np.nan, index=df.index)
    for c in cols:
        if c in df.columns:
            out = out.fillna(pd.to_numeric(df[c], errors="coerce"))
    return out


def scrub_codes(series: pd.Series) -> pd.Series:
    s = pd.to_numeric(series, errors="coerce")
    return s.mask(s.isin({7, 9, 77, 99, 777, 999, 7777, 9999}))


def yes_no_binary(series: pd.Series) -> pd.Series:
    s = scrub_codes(series)
    out = pd.Series(np.nan, index=s.index)
    out.loc[s == 1] = 1.0
    out.loc[s == 2] = 0.0
    return out


def weighted_mean(y: np.ndarray, w: np.ndarray) -> float:
    return float(np.sum(y * w) / np.sum(w)) if np.sum(w) > 0 else float("nan")


def weighted_brier(y: np.ndarray, p: np.ndarray, w: np.ndarray) -> float:
    return float(np.average((y - p) ** 2, weights=w))


def weighted_auc(y: np.ndarray, p: np.ndarray, w: np.ndarray) -> float:
    if len(np.unique(y)) < 2:
        return float("nan")
    return float(roc_auc_score(y, p, sample_weight=w))


def weighted_calibration_bins(y: np.ndarray, p: np.ndarray, w: np.ndarray, bins: int = 10) -> pd.DataFrame:
    q = np.quantile(p, np.linspace(0, 1, bins + 1))
    q = np.unique(q)
    rows: List[Dict[str, float]] = []
    for i in range(len(q) - 1):
        lo, hi = q[i], q[i + 1]
        if i < len(q) - 2:
            mask = (p >= lo) & (p < hi)
        else:
            mask = (p >= lo) & (p <= hi)
        if not np.any(mask):
            continue
        rows.append(
            {
                "pred_mean": weighted_mean(p[mask], w[mask]),
                "obs_mean": weighted_mean(y[mask], w[mask]),
            }
        )
    return pd.DataFrame(rows)


def download_nhanes_files(raw_root: Path, file_codes: List[str]) -> None:
    session = requests.Session()
    for cyc in CYCLES:
        cdir = raw_root / cyc["label"]
        cdir.mkdir(parents=True, exist_ok=True)
        for code in file_codes:
            path = cdir / f"{code}_{cyc['suffix']}.xpt"
            if path.exists() and path.stat().st_size > 1500:
                continue
            url = f"https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/{cyc['year']}/DataFiles/{code}_{cyc['suffix']}.xpt"
            try:
                r = session.get(url, timeout=90)
            except requests.RequestException:
                continue
            if r.status_code == 200 and len(r.content) > 1500 and not r.content.startswith(b"<!DOCTYPE html"):
                path.write_bytes(r.content)


def read_xpt(path: Path) -> pd.DataFrame:
    df = pd.read_sas(path, format="xport", encoding="utf-8")
    df.columns = [c.upper() for c in df.columns]
    return df


def merge_cycle(raw_root: Path, cycle: Dict[str, Any], file_codes: List[str]) -> pd.DataFrame:
    cdir = raw_root / cycle["label"]
    demo = cdir / f"DEMO_{cycle['suffix']}.xpt"
    if not demo.exists():
        raise FileNotFoundError(f"Missing DEMO file for {cycle['label']}")

    merged = read_xpt(demo)
    for code in file_codes:
        if code == "DEMO":
            continue
        p = cdir / f"{code}_{cycle['suffix']}.xpt"
        if not p.exists():
            continue
        df = read_xpt(p)
        if "SEQN" not in df.columns:
            continue
        cols = [c for c in df.columns if c == "SEQN" or c not in merged.columns]
        merged = merged.merge(df[cols], on="SEQN", how="left")

    merged["CYCLE_LABEL"] = cycle["label"]
    merged["CYCLE_YEAR"] = cycle["year"]
    merged["CYCLE_SUFFIX"] = cycle["suffix"]
    return merged


def row_mean_min_count(df: pd.DataFrame, cols: List[str], min_count: int = 3) -> pd.Series:
    vals = pd.DataFrame({c: pd.to_numeric(df[c], errors="coerce") if c in df.columns else np.nan for c in cols}, index=df.index)
    vals = vals.where((vals <= 120) & (vals >= -20), np.nan)
    out = vals.mean(axis=1)
    out[vals.notna().sum(axis=1) < min_count] = np.nan
    return out


def build_nhanes_analysis_dataset(merged: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=merged.index)

    out["seqn"] = safe_col(merged, "SEQN")
    out["cycle_label"] = merged["CYCLE_LABEL"]
    out["cycle_year"] = safe_col(merged, "CYCLE_YEAR")

    out["age"] = safe_col(merged, "RIDAGEYR")
    sex_num = safe_col(merged, "RIAGENDR")
    out["sex"] = sex_num.map({1: "Male", 2: "Female"}).fillna("Unknown")

    race_num = coalesce_numeric(merged, ["RIDRETH3", "RIDRETH1"])
    race_map = {
        1: "Mexican American",
        2: "Other Hispanic",
        3: "Non-Hispanic White",
        4: "Non-Hispanic Black",
        5: "Other Race",
        6: "Non-Hispanic Asian",
        7: "Other/Multi-Racial",
    }
    out["race_ethnicity"] = race_num.map(race_map).fillna("Unknown")

    out["height_cm"] = safe_col(merged, "BMXHT")
    out["bmi"] = safe_col(merged, "BMXBMI")
    out["pir"] = safe_col(merged, "INDFMPIR")

    wtmec2yr = safe_col(merged, "WTMEC2YR")
    wtint2yr = safe_col(merged, "WTINT2YR")
    out["sample_weight"] = wtmec2yr.fillna(wtint2yr) / 4.0

    out["systolic_bp"] = pd.concat([safe_col(merged, c) for c in ["BPXSY1", "BPXSY2", "BPXSY3", "BPXSY4"]], axis=1).mean(axis=1)
    out["diastolic_bp"] = pd.concat([safe_col(merged, c) for c in ["BPXDI1", "BPXDI2", "BPXDI3", "BPXDI4"]], axis=1).mean(axis=1)

    out["total_cholesterol"] = safe_col(merged, "LBXTC")
    out["hdl"] = safe_col(merged, "LBDHDD")
    out["ldl"] = safe_col(merged, "LBDLDL")
    out["hba1c"] = safe_col(merged, "LBXGH")
    out["creatinine"] = safe_col(merged, "LBXSCR")
    out["crp"] = coalesce_numeric(merged, ["LBXHSCRP", "LBXCRP"])

    female = sex_num == 2
    k = np.where(female, 0.7, 0.9)
    alpha = np.where(female, -0.241, -0.302)
    sex_mult = np.where(female, 1.012, 1.0)
    ratio = out["creatinine"] / k
    out["egfr"] = 142.0 * np.minimum(ratio, 1.0) ** alpha * np.maximum(ratio, 1.0) ** (-1.2) * (0.9938 ** out["age"]) * sex_mult

    ever_smoked = yes_no_binary(safe_col(merged, "SMQ020"))
    now_smokes = scrub_codes(safe_col(merged, "SMQ040"))
    out["current_smoker"] = np.where(now_smokes.isin([1, 2]), 1.0, np.where(now_smokes == 3, 0.0, np.nan))
    out["former_smoker"] = np.where((ever_smoked == 1) & (now_smokes == 3), 1.0, np.where(ever_smoked == 2, 0.0, np.nan))

    diq = yes_no_binary(safe_col(merged, "DIQ010"))
    out["diabetes"] = np.where((diq == 1) | (out["hba1c"] >= 6.5), 1.0, np.where((diq == 0) & out["hba1c"].notna(), 0.0, diq))

    out["bp_treated"] = yes_no_binary(safe_col(merged, "BPQ050A"))
    out["lipid_med"] = yes_no_binary(safe_col(merged, "BPQ100D"))

    # ASCVD proxy for PCE evaluation in NHANES.
    ascvd_components = pd.concat(
        [
            yes_no_binary(safe_col(merged, "MCQ160C")),
            yes_no_binary(safe_col(merged, "MCQ160D")),
            yes_no_binary(safe_col(merged, "MCQ160E")),
            yes_no_binary(safe_col(merged, "MCQ160F")),
        ],
        axis=1,
    )
    out["ascvd_proxy"] = ascvd_components.max(axis=1, skipna=True)

    # Vision/hearing self-report from PFQ cause codes.
    cause_cols = [safe_col(merged, c) for c in ["PFQ063A", "PFQ063B", "PFQ063C", "PFQ063D", "PFQ063E"]]
    causes = pd.concat(cause_cols, axis=1).apply(scrub_codes)
    has_any_cause = causes.notna().any(axis=1)
    hearing_cause = (causes == 18).any(axis=1)
    vision_cause = (causes == 26).any(axis=1)

    hearing_self = pd.Series(np.nan, index=merged.index)
    hearing_self.loc[has_any_cause & (~hearing_cause)] = 0.0
    hearing_self.loc[hearing_cause] = 1.0

    vision_self = pd.Series(np.nan, index=merged.index)
    vision_self.loc[has_any_cause & (~vision_cause)] = 0.0
    vision_self.loc[vision_cause] = 1.0

    # Objective hearing loss when audiometry data are present.
    pta_r = row_mean_min_count(merged, ["AUXU500R", "AUXU1K1R", "AUXU2KR", "AUXU4KR"], min_count=3)
    pta_l = row_mean_min_count(merged, ["AUXU500L", "AUXU1K1L", "AUXU2KL", "AUXU4KL"], min_count=3)
    better_ear = pd.concat([pta_r, pta_l], axis=1).min(axis=1)
    hearing_exam = pd.Series(np.nan, index=merged.index)
    hearing_exam.loc[better_ear.notna()] = (better_ear.loc[better_ear.notna()] > 25.0).astype(float)

    out["hearing_loss"] = hearing_exam.fillna(hearing_self)
    out["vision_loss"] = vision_self  # no objective vision exam file in 2011-2018 cycles found
    hearing_src = pd.Series(np.nan, index=merged.index, dtype=object)
    hearing_src.loc[hearing_self.notna()] = "pfq063_cause18"
    hearing_src.loc[hearing_exam.notna()] = "audiometry_pta_better_ear_gt25"
    out["hearing_loss_source"] = hearing_src

    vision_src = pd.Series(np.nan, index=merged.index, dtype=object)
    vision_src.loc[vision_self.notna()] = "pfq063_cause26"
    out["vision_loss_source"] = vision_src

    out = out[out["age"] >= 20].copy()
    out.loc[out["sample_weight"] <= 0, "sample_weight"] = np.nan

    return out


def write_outcome_definition_summary(df: pd.DataFrame, out_path: Path) -> None:
    rows: List[str] = []
    rows.append("# NHANES Outcome Definitions (2011-2018)")
    rows.append("")
    rows.append("## Harmonized Rules")
    rows.append("- `hearing_loss`: primary objective rule where audiometry present (better-ear PTA at 0.5/1/2/4 kHz > 25 dB); fallback self-report cause code (`PFQ063[A-E] == 18`).")
    rows.append("- `vision_loss`: self-report cause code (`PFQ063[A-E] == 26`) in these cycles.")
    rows.append("")
    rows.append("## Cycle-Level Availability")
    rows.append("| cycle | n_adults | hearing_loss_n | hearing_from_audiometry_n | hearing_from_self_report_n | vision_loss_n | vision_from_self_report_n |")
    rows.append("|---|---:|---:|---:|---:|---:|---:|")

    for cyc, gdf in df.groupby("cycle_label", dropna=False):
        n_adults = int(len(gdf))
        hearing_n = int(gdf["hearing_loss"].notna().sum())
        hearing_exam_n = int((gdf["hearing_loss_source"] == "audiometry_pta_better_ear_gt25").sum())
        hearing_self_n = int((gdf["hearing_loss_source"] == "pfq063_cause18").sum())
        vision_n = int(gdf["vision_loss"].notna().sum())
        vision_self_n = int((gdf["vision_loss_source"] == "pfq063_cause26").sum())
        rows.append(
            f"| {cyc} | {n_adults} | {hearing_n} | {hearing_exam_n} | {hearing_self_n} | {vision_n} | {vision_self_n} |"
        )

    out_path.write_text("\n".join(rows) + "\n")


def build_design_matrix(
    df: pd.DataFrame,
    continuous_cols: List[str],
    binary_cols: List[str],
    categorical_cols: List[str],
    state: PreprocessState | None = None,
) -> Tuple[pd.DataFrame, PreprocessState]:
    work = df.copy()

    if state is None:
        medians: Dict[str, float] = {}
        means: Dict[str, float] = {}
        stds: Dict[str, float] = {}
        for c in continuous_cols:
            med = safe_float(pd.to_numeric(work[c], errors="coerce").median(skipna=True), 0.0)
            medians[c] = med
            filled = pd.to_numeric(work[c], errors="coerce").fillna(med)
            means[c] = safe_float(filled.mean(), 0.0)
            st = safe_float(filled.std(ddof=0), 1.0)
            stds[c] = st if st > 0 else 1.0
    else:
        medians = state.medians
        means = state.means
        stds = state.stds

    cont_scaled = pd.DataFrame(index=work.index)
    missing_ind = pd.DataFrame(index=work.index)
    for c in continuous_cols:
        raw = pd.to_numeric(work[c], errors="coerce")
        missing_ind[f"{c}__missing"] = raw.isna().astype(float)
        filled = raw.fillna(medians[c])
        cont_scaled[c] = (filled - means[c]) / stds[c]

    age_filled = pd.to_numeric(work["age"], errors="coerce").fillna(medians["age"])
    if state is None:
        spline_transformer = SplineTransformer(n_knots=5, degree=3, include_bias=False, extrapolation="linear")
        spline_values = spline_transformer.fit_transform(age_filled.to_numpy().reshape(-1, 1))
        spline_columns = [f"age_spline_{i}" for i in range(spline_values.shape[1])]
    else:
        spline_transformer = state.spline_transformer
        spline_columns = state.spline_columns
        spline_values = spline_transformer.transform(age_filled.to_numpy().reshape(-1, 1))
    spline_df = pd.DataFrame(spline_values, index=work.index, columns=spline_columns)

    binary_df = pd.DataFrame(index=work.index)
    for c in binary_cols:
        binary_df[c] = pd.to_numeric(work[c], errors="coerce").fillna(0.0)

    cat = pd.DataFrame(index=work.index)
    for c in categorical_cols:
        cat[c] = work[c].fillna("Unknown").astype(str)
    dummies = pd.get_dummies(cat, prefix=categorical_cols, dummy_na=False, dtype=float)

    if state is None:
        dummy_columns = dummies.columns.tolist()
    else:
        dummy_columns = state.dummy_columns
        dummies = dummies.reindex(columns=dummy_columns, fill_value=0.0)

    sex_male = dummies["sex_Male"] if "sex_Male" in dummies.columns else pd.Series(0.0, index=work.index)
    interactions = pd.DataFrame(index=work.index)
    interactions["age_x_bmi"] = cont_scaled["age"] * cont_scaled["bmi"]
    interactions["age_x_smoking"] = cont_scaled["age"] * binary_df["current_smoker"]
    interactions["sex_x_bmi"] = sex_male * cont_scaled["bmi"]

    cont_no_age = cont_scaled.drop(columns=["age"])
    X = pd.concat([spline_df, cont_no_age, missing_ind, binary_df, dummies, interactions], axis=1)

    if state is None:
        final_columns = X.columns.tolist()
        state = PreprocessState(
            medians=medians,
            means=means,
            stds=stds,
            dummy_columns=dummy_columns,
            final_columns=final_columns,
            spline_transformer=spline_transformer,
            spline_columns=spline_columns,
        )
    else:
        X = X.reindex(columns=state.final_columns, fill_value=0.0)

    return X, state


def fit_logistic_with_cv(
    df: pd.DataFrame,
    target: str,
    weight_col: str,
    continuous_cols: List[str],
    binary_cols: List[str],
    categorical_cols: List[str],
    random_state: int = 42,
) -> Dict[str, Any]:
    model_df = df[df[target].notna()].copy()
    model_df = model_df[model_df[weight_col].notna()].copy()
    model_df[target] = model_df[target].astype(int)
    model_df = model_df.dropna(subset=["age"]).copy()

    y = model_df[target].to_numpy(dtype=int)
    w = model_df[weight_col].to_numpy(dtype=float)

    age_bins = pd.cut(model_df["age"], bins=[20, 35, 50, 65, 200], labels=["20-34", "35-49", "50-64", "65+"], right=False)
    strata = y.astype(str) + "_" + age_bins.astype(str).to_numpy()
    vc = pd.Series(strata).value_counts(dropna=False)
    if (vc < 5).any():
        strata = y.astype(str)

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=random_state)
    oof = np.zeros(len(model_df), dtype=float)

    for tr_idx, te_idx in cv.split(model_df, strata):
        tr_df = model_df.iloc[tr_idx]
        te_df = model_df.iloc[te_idx]
        X_tr, state = build_design_matrix(tr_df, continuous_cols, binary_cols, categorical_cols, None)
        X_te, _ = build_design_matrix(te_df, continuous_cols, binary_cols, categorical_cols, state)
        lr = LogisticRegression(max_iter=4000)
        lr.fit(X_tr, tr_df[target].to_numpy(dtype=int), sample_weight=tr_df[weight_col].to_numpy(dtype=float))
        oof[te_idx] = lr.predict_proba(X_te)[:, 1]

    auc = weighted_auc(y, oof, w)
    brier = weighted_brier(y, oof, w)
    cal_bins = weighted_calibration_bins(y, oof, w, bins=10)

    # Subgroup performance
    subgroup_rows: List[Dict[str, Any]] = []
    for group_col in ["sex", "race_ethnicity"]:
        for g, gdf in model_df.groupby(group_col):
            if len(gdf) < 30 or gdf[target].nunique() < 2:
                continue
            idx = gdf.index.to_numpy()
            # map to positional indices
            pos = model_df.index.get_indexer(idx)
            subgroup_rows.append(
                {
                    "group_type": group_col,
                    "group": str(g),
                    "n": int(len(gdf)),
                    "auc": weighted_auc(y[pos], oof[pos], w[pos]),
                }
            )

    # Fit final model on full data
    X_full, full_state = build_design_matrix(model_df, continuous_cols, binary_cols, categorical_cols, None)
    final_model = LogisticRegression(max_iter=4000)
    final_model.fit(X_full, y, sample_weight=w)

    return {
        "model_df": model_df,
        "oof_pred": oof,
        "auc": auc,
        "brier": brier,
        "calibration_bins": cal_bins,
        "subgroups": pd.DataFrame(subgroup_rows),
        "final_model": final_model,
        "state": full_state,
    }


def save_calibration_plot(cal_df: pd.DataFrame, out_path: Path, title: str) -> None:
    plt.figure(figsize=(5, 5))
    plt.plot([0, 1], [0, 1], linestyle="--", linewidth=1)
    plt.plot(cal_df["pred_mean"], cal_df["obs_mean"], marker="o")
    plt.xlabel("Predicted")
    plt.ylabel("Observed")
    plt.title(title)
    plt.tight_layout()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(out_path, dpi=150)
    plt.close()


def make_prevalence_curve(
    model: LogisticRegression,
    state: PreprocessState,
    model_df: pd.DataFrame,
    continuous_cols: List[str],
    binary_cols: List[str],
    categorical_cols: List[str],
    target: str,
) -> pd.DataFrame:
    ref: Dict[str, Any] = {}
    for c in continuous_cols:
        ref[c] = safe_float(pd.to_numeric(model_df[c], errors="coerce").median(skipna=True), 0.0)
    for b in binary_cols:
        mode = pd.to_numeric(model_df[b], errors="coerce").dropna().mode()
        ref[b] = float(mode.iloc[0]) if len(mode) else 0.0
    for c in categorical_cols:
        mode = model_df[c].dropna().astype(str).mode()
        ref[c] = mode.iloc[0] if len(mode) else "Unknown"

    rows: List[Dict[str, float]] = []
    for age in range(20, 91):
        row = ref.copy()
        row["age"] = float(age)
        X_row, _ = build_design_matrix(pd.DataFrame([row]), continuous_cols, binary_cols, categorical_cols, state)
        p = float(model.predict_proba(X_row)[:, 1][0])
        rows.append({"age": float(age), "predicted_prevalence": p})
    return pd.DataFrame(rows)


def write_inference_function(path: Path, model_rel_path: str, target_name: str) -> None:
    text = f'''"""Inference helper for {target_name}."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

import joblib
import numpy as np
import pandas as pd
from sklearn.preprocessing import SplineTransformer


def _build(df: pd.DataFrame, state: dict, continuous_cols, binary_cols, categorical_cols):
    med = state["medians"]
    means = state["means"]
    stds = state["stds"]
    cont = pd.DataFrame(index=df.index)
    miss = pd.DataFrame(index=df.index)
    for c in continuous_cols:
        s = pd.to_numeric(df.get(c), errors="coerce")
        if s is None:
            s = pd.Series(np.nan, index=df.index)
        miss[f"{{c}}__missing"] = s.isna().astype(float)
        f = s.fillna(med[c])
        cont[c] = (f - means[c]) / stds[c]
    age_filled = pd.to_numeric(df["age"], errors="coerce").fillna(med["age"]).to_numpy().reshape(-1, 1)
    spline_values = state["spline_transformer"].transform(age_filled)
    spline = pd.DataFrame(spline_values, columns=state["spline_columns"], index=df.index)
    bin_df = pd.DataFrame(index=df.index)
    for b in binary_cols:
        bin_df[b] = pd.to_numeric(df.get(b, 0), errors="coerce").fillna(0.0)
    cat = pd.DataFrame(index=df.index)
    for c in categorical_cols:
        cat[c] = df[c].fillna("Unknown").astype(str) if c in df.columns else "Unknown"
    dummies = pd.get_dummies(cat, prefix=categorical_cols, dummy_na=False, dtype=float)
    dummies = dummies.reindex(columns=state["dummy_columns"], fill_value=0.0)
    sex_male = dummies["sex_Male"] if "sex_Male" in dummies.columns else pd.Series(0.0, index=df.index)
    inter = pd.DataFrame(index=df.index)
    inter["age_x_bmi"] = cont["age"] * cont["bmi"]
    inter["age_x_smoking"] = cont["age"] * bin_df["current_smoker"]
    inter["sex_x_bmi"] = sex_male * cont["bmi"]
    X = pd.concat([spline, cont.drop(columns=["age"]), miss, bin_df, dummies, inter], axis=1)
    return X.reindex(columns=state["final_columns"], fill_value=0.0)


def predict_prevalence(age: float, covariates: Dict[str, Any] | None = None) -> float:
    bundle = joblib.load(Path(__file__).resolve().parent / "{model_rel_path}")
    model = bundle["model"]
    state = bundle["state"]
    row = dict(covariates or {{}})
    row["age"] = float(age)
    X = _build(pd.DataFrame([row]), state, bundle["continuous_cols"], bundle["binary_cols"], bundle["categorical_cols"])
    return float(model.predict_proba(X)[:,1][0])
'''
    path.write_text(text)


# PCE (Goff 2013) parameters from ACC/AHA guideline Table A.
PCE_PARAMS = {
    ("female", "white"): {
        "coeff": {
            "ln_age": -29.799,
            "ln_age_sq": 4.884,
            "ln_tc": 13.540,
            "ln_age_ln_tc": -3.114,
            "ln_hdl": -13.578,
            "ln_age_ln_hdl": 3.149,
            "ln_treated_sbp": 2.019,
            "ln_untreated_sbp": 1.957,
            "smoker": 7.574,
            "ln_age_smoker": -1.665,
            "diabetes": 0.661,
        },
        "mean": -29.18,
        "baseline_survival": 0.9665,
    },
    ("female", "black"): {
        "coeff": {
            "ln_age": 17.114,
            "ln_tc": 0.940,
            "ln_hdl": -18.920,
            "ln_age_ln_hdl": 4.475,
            "ln_treated_sbp": 29.291,
            "ln_age_ln_treated_sbp": -6.432,
            "ln_untreated_sbp": 27.820,
            "ln_age_ln_untreated_sbp": -6.087,
            "smoker": 0.691,
            "diabetes": 0.874,
        },
        "mean": 86.61,
        "baseline_survival": 0.9533,
    },
    ("male", "white"): {
        "coeff": {
            "ln_age": 12.344,
            "ln_tc": 11.853,
            "ln_age_ln_tc": -2.664,
            "ln_hdl": -7.990,
            "ln_age_ln_hdl": 1.769,
            "ln_treated_sbp": 1.797,
            "ln_untreated_sbp": 1.764,
            "smoker": 7.837,
            "ln_age_smoker": -1.795,
            "diabetes": 0.658,
        },
        "mean": 61.18,
        "baseline_survival": 0.9144,
    },
    ("male", "black"): {
        "coeff": {
            "ln_age": 2.469,
            "ln_tc": 0.302,
            "ln_hdl": -0.307,
            "ln_treated_sbp": 1.916,
            "ln_untreated_sbp": 1.809,
            "smoker": 0.549,
            "diabetes": 0.645,
        },
        "mean": 19.54,
        "baseline_survival": 0.8954,
    },
}


def pce_10y_ascvd_risk(person: Dict[str, Any]) -> float:
    age = safe_float(person.get("age"))
    tc = safe_float(person.get("total_cholesterol"))
    hdl = safe_float(person.get("hdl"))
    sbp = safe_float(person.get("systolic_bp"))
    treated = int(safe_float(person.get("bp_treated"), 0.0) == 1.0)
    smoker = int(safe_float(person.get("current_smoker"), 0.0) == 1.0)
    diabetes = int(safe_float(person.get("diabetes"), 0.0) == 1.0)

    if not (np.isfinite(age) and np.isfinite(tc) and np.isfinite(hdl) and np.isfinite(sbp)):
        return float("nan")
    if age <= 0 or tc <= 0 or hdl <= 0 or sbp <= 0:
        return float("nan")

    sx = str(person.get("sex", "")).strip().lower()
    if sx not in {"male", "female"}:
        sx = "male" if safe_float(person.get("sex"), 1.0) == 1 else "female"

    race = str(person.get("race_pce", "")).strip().lower()
    race = "black" if race == "black" else "white"

    params = PCE_PARAMS[(sx, race)]
    c = params["coeff"]

    ln_age = np.log(age)
    ln_tc = np.log(tc)
    ln_hdl = np.log(hdl)
    ln_sbp = np.log(sbp)

    s = 0.0
    s += c.get("ln_age", 0.0) * ln_age
    s += c.get("ln_age_sq", 0.0) * (ln_age**2)
    s += c.get("ln_tc", 0.0) * ln_tc
    s += c.get("ln_age_ln_tc", 0.0) * (ln_age * ln_tc)
    s += c.get("ln_hdl", 0.0) * ln_hdl
    s += c.get("ln_age_ln_hdl", 0.0) * (ln_age * ln_hdl)

    if treated == 1:
        s += c.get("ln_treated_sbp", 0.0) * ln_sbp
        s += c.get("ln_age_ln_treated_sbp", 0.0) * (ln_age * ln_sbp)
    else:
        s += c.get("ln_untreated_sbp", 0.0) * ln_sbp
        s += c.get("ln_age_ln_untreated_sbp", 0.0) * (ln_age * ln_sbp)

    s += c.get("smoker", 0.0) * smoker
    s += c.get("ln_age_smoker", 0.0) * (ln_age * smoker)
    s += c.get("diabetes", 0.0) * diabetes

    risk = 1.0 - (params["baseline_survival"] ** np.exp(s - params["mean"]))
    return float(np.clip(risk, 0.0, 1.0))


def evaluate_pce(df: pd.DataFrame, out_dir: Path) -> Dict[str, Any]:
    pce_df = df.copy()
    pce_df = pce_df[(pce_df["age"] >= 40) & (pce_df["age"] <= 79)].copy()
    pce_df["race_pce"] = np.where(pce_df["race_ethnicity"] == "Non-Hispanic Black", "black", "white")

    req = ["age", "sex", "total_cholesterol", "hdl", "systolic_bp", "bp_treated", "current_smoker", "diabetes", "ascvd_proxy", "sample_weight"]
    pce_df = pce_df.dropna(subset=req).copy()
    pce_df["pce_risk_10y"] = pce_df.apply(lambda r: pce_10y_ascvd_risk(r.to_dict()), axis=1)
    pce_df = pce_df[pce_df["pce_risk_10y"].notna()].copy()

    y = pce_df["ascvd_proxy"].astype(int).to_numpy()
    p = pce_df["pce_risk_10y"].to_numpy(dtype=float)
    w = pce_df["sample_weight"].to_numpy(dtype=float)

    auc = weighted_auc(y, p, w)
    brier = weighted_brier(y, p, w)

    cal = weighted_calibration_bins(y, p, w, bins=10)
    save_calibration_plot(cal, out_dir / "pce_calibration.png", "PCE calibration vs NHANES ASCVD proxy")

    plt.figure(figsize=(6, 4))
    plt.hist(p, bins=30)
    plt.xlabel("Predicted 10-year ASCVD risk")
    plt.ylabel("Count")
    plt.title("PCE risk distribution in NHANES")
    plt.tight_layout()
    plt.savefig(out_dir / "pce_risk_hist.png", dpi=150)
    plt.close()

    pce_df[["seqn", "pce_risk_10y", "ascvd_proxy"]].to_csv(out_dir / "pce_predictions.csv", index=False)

    metrics = {
        "n_eval": int(len(pce_df)),
        "auc_vs_ascvd_proxy": auc,
        "brier_vs_ascvd_proxy": brier,
        "proxy_prevalence_weighted": weighted_mean(y, w),
        "note": "PCE predicts 10-year incident ASCVD risk; NHANES proxy is cross-sectional disease history.",
    }

    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
    return metrics


def write_pce_sources(out_path: Path) -> None:
    text = """# PCE Sources

## 1) ACC/AHA 2013 Risk Guideline (Primary source)
- URL: https://pmc.ncbi.nlm.nih.gov/articles/PMC4700825/
- Citation: Goff DC Jr, et al. 2013 ACC/AHA Guideline on the Assessment of Cardiovascular Risk.
- Used for: Table A coefficients, race/sex-specific means, and baseline survival terms; equation form for 10-year risk.
- Key extracted values implemented:
  - White women mean = -29.18, baseline survival = 0.9665
  - Black women mean = 86.61, baseline survival = 0.9533
  - White men mean = 61.18, baseline survival = 0.9144
  - Black men mean = 19.54, baseline survival = 0.8954

## 2) ACC-hosted summary/context
- URL: https://www.acc.org/Latest-in-Cardiology/Journal-Scans/2013/11/11/15/28/2013-ACC-AHA-Guideline-on-the-Assessment-of-CV-Risk
- Used for: endpoint definition context (hard ASCVD = MI/CHD death/stroke) and example profile checks.

## 3) Validated implementation reference
- URL: https://bcjaeger.github.io/PooledCohort/reference/predict_10yr_ascvd_risk.html
- Used for: implementation cross-checking of input schema and expected example outputs (consistency check only).
"""
    out_path.write_text(text)


def save_model_outputs(
    result: Dict[str, Any],
    target: str,
    out_dir: Path,
    continuous_cols: List[str],
    binary_cols: List[str],
    categorical_cols: List[str],
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    model = result["final_model"]
    state = result["state"]
    model_df = result["model_df"]

    coeff = dict(zip(state.final_columns, model.coef_[0].tolist()))
    coeff_json = {
        "target": target,
        "intercept": float(model.intercept_[0]),
        "coefficients": coeff,
        "auc": result["auc"],
        "brier": result["brier"],
        "n": int(len(model_df)),
        "events": int(model_df[target].sum()),
    }

    (out_dir / "model_coefficients.json").write_text(json.dumps(coeff_json, indent=2))
    pd.DataFrame([{"auc": result["auc"], "brier": result["brier"], "n": len(model_df), "events": int(model_df[target].sum())}]).to_csv(
        out_dir / "metrics.csv", index=False
    )

    result["subgroups"].to_csv(out_dir / "subgroup_performance.csv", index=False)

    save_calibration_plot(result["calibration_bins"], out_dir / "calibration.png", f"Calibration: {target}")

    curve = make_prevalence_curve(model, state, model_df, continuous_cols, binary_cols, categorical_cols, target)
    curve.to_csv(out_dir / "prevalence_curve_age.csv", index=False)
    plt.figure(figsize=(7, 4))
    plt.plot(curve["age"], curve["predicted_prevalence"], linewidth=2)
    plt.xlabel("Age")
    plt.ylabel("Predicted prevalence")
    plt.title(f"Prevalence vs Age: {target}")
    plt.tight_layout()
    plt.savefig(out_dir / "prevalence_curve_age.png", dpi=150)
    plt.close()

    bundle = {
        "model": model,
        "state": {
            "medians": state.medians,
            "means": state.means,
            "stds": state.stds,
            "dummy_columns": state.dummy_columns,
            "final_columns": state.final_columns,
            "spline_transformer": state.spline_transformer,
            "spline_columns": state.spline_columns,
        },
        "continuous_cols": continuous_cols,
        "binary_cols": binary_cols,
        "categorical_cols": categorical_cols,
    }
    joblib.dump(bundle, out_dir / f"{target}_model.joblib")

    write_inference_function(out_dir / f"predict_{target}.py", f"{target}_model.joblib", target)


def load_aric_dataset(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix == ".parquet":
        return pd.read_parquet(path)
    if suffix in {".sas7bdat", ".xpt"}:
        return pd.read_sas(path)
    raise ValueError(f"Unsupported ARIC file type: {suffix}")


def fit_aric_stroke(aric_cfg: Dict[str, Any], out_dir: Path) -> Dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = Path(aric_cfg["path"])
    if not path.exists():
        return {"status": "missing", "message": "ARIC dataset not found at configured path."}

    df = load_aric_dataset(path)
    cols = aric_cfg.get("columns", {})

    req = [
        cols.get("age", "age"),
        cols.get("sex", "sex"),
        cols.get("race", "race"),
        cols.get("bmi", "bmi"),
        cols.get("smoker", "smoker"),
        cols.get("sbp", "sbp"),
        cols.get("dbp", "dbp"),
        cols.get("diabetes", "diabetes"),
        cols.get("total_cholesterol", "total_cholesterol"),
        cols.get("hdl", "hdl"),
    ]

    horizon = float(aric_cfg.get("horizon_years", 10))

    if cols.get("stroke_event") in df.columns:
        stroke = pd.to_numeric(df[cols["stroke_event"]], errors="coerce")
    else:
        stroke_flag = pd.to_numeric(df[cols.get("stroke_flag", "stroke_flag")], errors="coerce")
        stroke_time = pd.to_numeric(df[cols.get("stroke_time_years", "stroke_time_years")], errors="coerce")
        followup = pd.to_numeric(df[cols.get("followup_time_years", "followup_time_years")], errors="coerce")
        stroke = pd.Series(np.nan, index=df.index)
        stroke.loc[(stroke_flag == 1) & (stroke_time <= horizon)] = 1
        stroke.loc[(followup >= horizon) & ((stroke_flag == 0) | (stroke_time > horizon))] = 0

    work = pd.DataFrame(index=df.index)
    work["age"] = pd.to_numeric(df[cols.get("age", "age")], errors="coerce")
    work["sex"] = df[cols.get("sex", "sex")].astype(str)
    work["race_ethnicity"] = df[cols.get("race", "race")].astype(str)
    work["bmi"] = pd.to_numeric(df[cols.get("bmi", "bmi")], errors="coerce")
    work["current_smoker"] = pd.to_numeric(df[cols.get("smoker", "smoker")], errors="coerce")
    work["systolic_bp"] = pd.to_numeric(df[cols.get("sbp", "sbp")], errors="coerce")
    work["diastolic_bp"] = pd.to_numeric(df[cols.get("dbp", "dbp")], errors="coerce")
    work["diabetes"] = pd.to_numeric(df[cols.get("diabetes", "diabetes")], errors="coerce")
    work["total_cholesterol"] = pd.to_numeric(df[cols.get("total_cholesterol", "total_cholesterol")], errors="coerce")
    work["hdl"] = pd.to_numeric(df[cols.get("hdl", "hdl")], errors="coerce")
    work["pir"] = pd.to_numeric(df[cols.get("pir", "pir")], errors="coerce") if cols.get("pir", "pir") in df.columns else np.nan
    work["stroke_event"] = stroke
    work["sample_weight"] = 1.0

    continuous = ["age", "bmi", "systolic_bp", "diastolic_bp", "total_cholesterol", "hdl", "pir"]
    binary = ["current_smoker", "diabetes"]
    categorical = ["sex", "race_ethnicity"]

    result = fit_logistic_with_cv(work, "stroke_event", "sample_weight", continuous, binary, categorical)

    coeff = dict(zip(result["state"].final_columns, result["final_model"].coef_[0].tolist()))
    (out_dir / "model_coefficients.json").write_text(
        json.dumps(
            {
                "target": "stroke_event",
                "intercept": float(result["final_model"].intercept_[0]),
                "coefficients": coeff,
                "auc": result["auc"],
                "brier": result["brier"],
            },
            indent=2,
        )
    )

    result["subgroups"].to_csv(out_dir / "subgroup_performance.csv", index=False)
    pd.DataFrame([{"auc": result["auc"], "brier": result["brier"], "n": len(result["model_df"]), "events": int(result["model_df"]["stroke_event"].sum())}]).to_csv(
        out_dir / "metrics.csv", index=False
    )
    save_calibration_plot(result["calibration_bins"], out_dir / "calibration.png", "Calibration: ARIC stroke_event")

    bundle = {
        "model": result["final_model"],
        "state": {
            "medians": result["state"].medians,
            "means": result["state"].means,
            "stds": result["state"].stds,
            "dummy_columns": result["state"].dummy_columns,
            "final_columns": result["state"].final_columns,
            "spline_transformer": result["state"].spline_transformer,
            "spline_columns": result["state"].spline_columns,
        },
        "continuous_cols": continuous,
        "binary_cols": binary,
        "categorical_cols": categorical,
    }
    joblib.dump(bundle, out_dir / "stroke_event_model.joblib")
    write_inference_function(out_dir / "predict_stroke_event.py", "stroke_event_model.joblib", "stroke_event")

    return {"status": "ok", "auc": result["auc"], "brier": result["brier"]}


def write_aric_required_columns(path: Path) -> None:
    text = """# ARIC_REQUIRED_COLUMNS

If ARIC data are provided, the pipeline expects either a direct binary outcome column
`stroke_event` OR the triplet below to construct a fixed-horizon binary endpoint:
- `stroke_flag` (1 if stroke occurred, 0 otherwise)
- `stroke_time_years` (time to stroke)
- `followup_time_years` (censoring/follow-up duration)

Required baseline predictor columns (or map in `config.yaml`):
- `age`
- `sex`
- `race`
- `bmi`
- `smoker`
- `sbp`
- `dbp`
- `diabetes`
- `total_cholesterol`
- `hdl`
- optional: `pir`

Deterministic fixed-horizon rule used when `stroke_event` is not directly present:
- `stroke_event = 1` if `stroke_flag==1` and `stroke_time_years <= horizon`
- `stroke_event = 0` if `followup_time_years >= horizon` and no stroke within horizon
- otherwise excluded as censored within horizon.
"""
    path.write_text(text)


def run_pipeline(config_path: Path) -> None:
    cfg = yaml.safe_load(config_path.read_text())

    raw_dir = Path(cfg["nhanes"]["paths"]["raw_dir"])
    out_root = Path(cfg["nhanes"]["paths"]["output_dir"])
    out_root.mkdir(parents=True, exist_ok=True)

    nhanes_dir = out_root / "nhanes"
    pce_dir = out_root / "pce"
    aric_dir = out_root / "aric" / "stroke"
    nhanes_dir.mkdir(parents=True, exist_ok=True)
    pce_dir.mkdir(parents=True, exist_ok=True)
    aric_dir.mkdir(parents=True, exist_ok=True)

    # 1) NHANES build
    file_codes = cfg["nhanes"].get("file_codes", NHANES_FILE_CODES)
    download_nhanes_files(raw_dir, file_codes)

    frames = [merge_cycle(raw_dir, cyc, file_codes) for cyc in CYCLES]
    merged = pd.concat(frames, ignore_index=True, sort=False)
    analysis_df = build_nhanes_analysis_dataset(merged)
    analysis_df.to_csv(nhanes_dir / "nhanes_vision_hearing_analysis_dataset.csv.gz", index=False, compression="gzip")
    write_outcome_definition_summary(analysis_df, nhanes_dir / "OUTCOME_DEFINITIONS.md")

    continuous_cols = cfg["nhanes"]["features"]["continuous"]
    binary_cols = cfg["nhanes"]["features"]["binary"]
    categorical_cols = cfg["nhanes"]["features"]["categorical"]

    # 2) Vision model (logistic prevalence model)
    vision_result = fit_logistic_with_cv(analysis_df, "vision_loss", "sample_weight", continuous_cols, binary_cols, categorical_cols)
    save_model_outputs(vision_result, "vision_loss", nhanes_dir / "vision_loss", continuous_cols, binary_cols, categorical_cols)

    # 3) Hearing model (objective audiometry preferred; self-report fallback)
    hearing_result = fit_logistic_with_cv(analysis_df, "hearing_loss", "sample_weight", continuous_cols, binary_cols, categorical_cols)
    save_model_outputs(hearing_result, "hearing_loss", nhanes_dir / "hearing_loss", continuous_cols, binary_cols, categorical_cols)

    # 4) PCE implementation + NHANES evaluation
    pce_py = """from __future__ import annotations\n\nimport numpy as np\n\nPCE_PARAMS = """ + repr(PCE_PARAMS) + """\n\n\ndef _sf(x):\n    try:\n        v=float(x)\n    except Exception:\n        return np.nan\n    return v if np.isfinite(v) else np.nan\n\n\ndef pce_10y_ascvd_risk(person):\n    age=_sf(person.get('age'))\n    tc=_sf(person.get('total_cholesterol'))\n    hdl=_sf(person.get('hdl'))\n    sbp=_sf(person.get('systolic_bp'))\n    tr=int(_sf(person.get('bp_treated') or 0)==1)\n    sm=int(_sf(person.get('current_smoker') or 0)==1)\n    dm=int(_sf(person.get('diabetes') or 0)==1)\n    if not (np.isfinite(age) and np.isfinite(tc) and np.isfinite(hdl) and np.isfinite(sbp)):\n        return float('nan')\n    if min(age,tc,hdl,sbp)<=0:\n        return float('nan')\n    sex=str(person.get('sex','')).strip().lower()\n    if sex not in {'male','female'}:\n        sex='male' if _sf(person.get('sex') or 1)==1 else 'female'\n    race='black' if str(person.get('race_pce','')).strip().lower()=='black' else 'white'\n    p=PCE_PARAMS[(sex,race)]\n    c=p['coeff']\n    la=np.log(age); ltc=np.log(tc); lhdl=np.log(hdl); lsbp=np.log(sbp)\n    s=0.0\n    s+=c.get('ln_age',0)*la\n    s+=c.get('ln_age_sq',0)*(la**2)\n    s+=c.get('ln_tc',0)*ltc\n    s+=c.get('ln_age_ln_tc',0)*(la*ltc)\n    s+=c.get('ln_hdl',0)*lhdl\n    s+=c.get('ln_age_ln_hdl',0)*(la*lhdl)\n    if tr==1:\n        s+=c.get('ln_treated_sbp',0)*lsbp\n        s+=c.get('ln_age_ln_treated_sbp',0)*(la*lsbp)\n    else:\n        s+=c.get('ln_untreated_sbp',0)*lsbp\n        s+=c.get('ln_age_ln_untreated_sbp',0)*(la*lsbp)\n    s+=c.get('smoker',0)*sm\n    s+=c.get('ln_age_smoker',0)*(la*sm)\n    s+=c.get('diabetes',0)*dm\n    risk=1-(p['baseline_survival']**np.exp(s-p['mean']))\n    return float(np.clip(risk,0,1))\n"""
    (pce_dir / "pce.py").write_text(pce_py)

    write_pce_sources(pce_dir / "pce_sources.md")
    pce_metrics = evaluate_pce(analysis_df, pce_dir)

    # 5) ARIC model if present
    write_aric_required_columns(aric_dir / "ARIC_REQUIRED_COLUMNS.md")
    aric_status = fit_aric_stroke(cfg["aric"], aric_dir)
    (aric_dir / "aric_status.json").write_text(json.dumps(aric_status, indent=2))

    # 6) Manifest
    manifest = {
        "nhanes_dataset": str(nhanes_dir / "nhanes_vision_hearing_analysis_dataset.csv.gz"),
        "vision_dir": str(nhanes_dir / "vision_loss"),
        "hearing_dir": str(nhanes_dir / "hearing_loss"),
        "pce_dir": str(pce_dir),
        "aric_dir": str(aric_dir),
        "pce_metrics": pce_metrics,
        "aric_status": aric_status,
    }
    (out_root / "manifest_pipeline.json").write_text(json.dumps(manifest, indent=2))

    print(json.dumps(manifest, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="NHANES Vision/Hearing + PCE + ARIC pipeline")
    parser.add_argument("--config", type=Path, default=Path("/Users/pranshusuyal/Downloads/codexdata/config.yaml"))
    args = parser.parse_args()
    run_pipeline(args.config)


if __name__ == "__main__":
    main()
