"""Minimal NHANES utilities for hearing loss analysis dataset."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd


CYCLES: List[Dict[str, Any]] = [
    {"label": "2011-2012", "year": 2011, "suffix": "G"},
    {"label": "2013-2014", "year": 2013, "suffix": "H"},
    {"label": "2015-2016", "year": 2015, "suffix": "I"},
    {"label": "2017-2018", "year": 2017, "suffix": "J"},
]


def safe_col(df: pd.DataFrame, col: str) -> pd.Series:
    if col in df.columns:
        return pd.to_numeric(df[col], errors="coerce")
    return pd.Series(np.nan, index=df.index)


def scrub_codes(series: pd.Series) -> pd.Series:
    s = pd.to_numeric(series, errors="coerce")
    return s.mask(s.isin({7, 9, 77, 99, 777, 999, 7777, 9999}))


def read_xpt(path: Path) -> pd.DataFrame:
    df = pd.read_sas(path, format="xport", encoding="utf-8")
    df.columns = [c.upper() for c in df.columns]
    return df


def merge_cycle(raw_root: Path, cycle: Dict[str, Any], file_codes: List[str]) -> pd.DataFrame:
    cdir = raw_root / cycle["label"]
    merged = read_xpt(cdir / f"DEMO_{cycle['suffix']}.xpt")
    for code in file_codes:
        if code == "DEMO":
            continue
        p = cdir / f"{code}_{cycle['suffix']}.xpt"
        if not p.exists():
            continue
        df = read_xpt(p)
        cols = [c for c in df.columns if c == "SEQN" or c not in merged.columns]
        merged = merged.merge(df[cols], on="SEQN", how="left")
    merged["CYCLE_LABEL"] = cycle["label"]
    return merged


def row_mean_min_count(df: pd.DataFrame, cols: List[str], min_count: int = 3) -> pd.Series:
    vals = pd.DataFrame({c: pd.to_numeric(df[c], errors="coerce") if c in df.columns else np.nan for c in cols}, index=df.index)
    vals = vals.where((vals <= 120) & (vals >= -20), np.nan)
    out = vals.mean(axis=1)
    out[vals.notna().sum(axis=1) < min_count] = np.nan
    return out


def build_hearing_analysis_dataset(merged: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=merged.index)
    out["seqn"] = safe_col(merged, "SEQN")
    out["age"] = safe_col(merged, "RIDAGEYR")
    out["sex"] = safe_col(merged, "RIAGENDR").map({1: "Male", 2: "Female"}).fillna("Unknown")

    race_num = safe_col(merged, "RIDRETH3").fillna(safe_col(merged, "RIDRETH1"))
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
    out["sample_weight"] = safe_col(merged, "WTMEC2YR").fillna(safe_col(merged, "WTINT2YR")) / 4.0

    out["bmi"] = safe_col(merged, "BMXBMI")
    out["systolic_bp"] = pd.concat([safe_col(merged, c) for c in ["BPXSY1", "BPXSY2", "BPXSY3", "BPXSY4"]], axis=1).mean(axis=1)
    out["diastolic_bp"] = pd.concat([safe_col(merged, c) for c in ["BPXDI1", "BPXDI2", "BPXDI3", "BPXDI4"]], axis=1).mean(axis=1)
    out["total_cholesterol"] = safe_col(merged, "LBXTC")
    out["hdl"] = safe_col(merged, "LBDHDD")
    out["ldl"] = safe_col(merged, "LBDLDL")
    out["hba1c"] = safe_col(merged, "LBXGH")
    out["creatinine"] = safe_col(merged, "LBXSCR")
    out["crp"] = safe_col(merged, "LBXHSCRP").fillna(safe_col(merged, "LBXCRP"))
    out["pir"] = safe_col(merged, "INDFMPIR")

    female = safe_col(merged, "RIAGENDR") == 2
    k = np.where(female, 0.7, 0.9)
    alpha = np.where(female, -0.241, -0.302)
    sex_mult = np.where(female, 1.012, 1.0)
    ratio = out["creatinine"] / k
    out["egfr"] = 142.0 * np.minimum(ratio, 1.0) ** alpha * np.maximum(ratio, 1.0) ** (-1.2) * (0.9938 ** out["age"]) * sex_mult

    smq040 = scrub_codes(safe_col(merged, "SMQ040"))
    out["current_smoker"] = np.where(smq040.isin([1, 2]), 1.0, np.where(smq040 == 3, 0.0, np.nan))
    diq010 = scrub_codes(safe_col(merged, "DIQ010"))
    out["diabetes"] = np.where((diq010 == 1) | (out["hba1c"] >= 6.5), 1.0, np.where((diq010 == 2) & out["hba1c"].notna(), 0.0, np.nan))
    out["bp_treated"] = np.where(scrub_codes(safe_col(merged, "BPQ050A")) == 1, 1.0, np.where(scrub_codes(safe_col(merged, "BPQ050A")) == 2, 0.0, np.nan))
    out["lipid_med"] = np.where(scrub_codes(safe_col(merged, "BPQ100D")) == 1, 1.0, np.where(scrub_codes(safe_col(merged, "BPQ100D")) == 2, 0.0, np.nan))

    cause_cols = [safe_col(merged, c) for c in ["PFQ063A", "PFQ063B", "PFQ063C", "PFQ063D", "PFQ063E"]]
    causes = pd.concat(cause_cols, axis=1).apply(scrub_codes)
    has_any_cause = causes.notna().any(axis=1)
    hearing_cause = (causes == 18).any(axis=1)
    hearing_self = pd.Series(np.nan, index=merged.index)
    hearing_self.loc[has_any_cause & (~hearing_cause)] = 0.0
    hearing_self.loc[hearing_cause] = 1.0

    pta_r = row_mean_min_count(merged, ["AUXU500R", "AUXU1K1R", "AUXU2KR", "AUXU4KR"], min_count=3)
    pta_l = row_mean_min_count(merged, ["AUXU500L", "AUXU1K1L", "AUXU2KL", "AUXU4KL"], min_count=3)
    better_ear = pd.concat([pta_r, pta_l], axis=1).min(axis=1)
    hearing_exam = pd.Series(np.nan, index=merged.index)
    hearing_exam.loc[better_ear.notna()] = (better_ear.loc[better_ear.notna()] > 25.0).astype(float)
    out["hearing_loss"] = hearing_exam.fillna(hearing_self)

    out = out[out["age"] >= 20].copy()
    out = out[out["sample_weight"] > 0].copy()
    return out
