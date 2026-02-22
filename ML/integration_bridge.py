#!/usr/bin/env python3
"""Bridge script for TypeScript backend -> existing ML Stage1/Stage2 Python code."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import joblib

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from stage1_biomarker_simulation import (  # noqa: E402
    DEFAULT_BOUNDS,
    _deserialize_process_models,
    load_process_models,
    simulate_biomarkers,
)
from simulation_engine import DiseaseRiskEngine  # noqa: E402


def _to_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(out):
        return None
    return out


def _safe_mean(values: list[float]) -> float:
    if not values:
        return float("nan")
    return float(np.mean(np.asarray(values, dtype=float)))


def _canonical_to_stage_profile(canonical: dict[str, Any]) -> dict[str, Any]:
    demographics = canonical.get("demographics", {})
    body = canonical.get("body", {})
    vitals = canonical.get("vitals", {})
    labs = canonical.get("labs", {})
    behaviors = canonical.get("behaviors", {})

    age = _to_float(demographics.get("age"))
    sex = demographics.get("sex")
    race = demographics.get("race_ethnicity")

    profile: dict[str, Any] = {
        "age": age if age is not None else 50.0,
        "sex": str(sex) if sex else "Unknown",
        "race_ethnicity": str(race) if race else "Unknown",
        "region_proxy": 0,
        "pir": _to_float(demographics.get("ses_pir")),
        "height_cm": _to_float(body.get("height_cm")),
        "bmi": _to_float(body.get("bmi")),
        "systolic_bp": _to_float(vitals.get("sbp")),
        "resting_hr": _to_float(vitals.get("resting_hr")),
        "ldl": _to_float(labs.get("ldl")),
        "hdl": _to_float(labs.get("hdl")),
        "total_cholesterol": _to_float(labs.get("total_cholesterol")),
        "hba1c": _to_float(labs.get("hba1c")),
        "egfr": _to_float(labs.get("egfr")),
        "sleep_hours": _to_float(behaviors.get("sleep_hours")),
        "alcohol_drinks_per_day": _to_float(behaviors.get("alcohol_drinks_per_day")),
        "pa_minutes_week": _to_float(behaviors.get("pa_minutes_week")),
        "diet_quality_indicator": _to_float(behaviors.get("diet_quality_indicator")),
    }

    # Remove None to let stage model default internally.
    return {k: v for k, v in profile.items() if v is not None}


def _load_models_with_backcompat(model_artifact: Path):
    try:
        return load_process_models(model_artifact)
    except KeyError as exc:
        # Backward compatibility for artifacts serialized before `model_class` was added.
        if str(exc) != "'model_class'":
            raise

        payload = joblib.load(model_artifact)
        if not isinstance(payload, dict):
            raise TypeError("Expected serialized process model payload to be a dict")

        patched: dict[str, dict[str, Any]] = {}
        for biomarker, model_dict in payload.items():
            if not isinstance(model_dict, dict):
                continue

            record = dict(model_dict)
            record.setdefault("biomarker", biomarker)
            # Legacy artifacts were trained with the baseline OU class and do not include
            # transition/regime payloads required by newer specialized classes.
            record.setdefault("model_class", "gaussian_ou")
            record.setdefault("bounds", DEFAULT_BOUNDS.get(biomarker, (0.0, 1.0)))
            record.setdefault("transform_params", None)
            record.setdefault("regimes", None)
            record.setdefault("transition_model", None)
            record.setdefault("regime_corr", None)
            record.setdefault("lipid_order", None)
            record.setdefault("mean_model_rmse", float("nan"))
            record.setdefault("n_obs", 0)
            patched[biomarker] = record

        return _deserialize_process_models(patched)


def _stage1(payload: dict[str, Any]) -> dict[str, Any]:
    model_artifact = Path(payload["model_artifact"]).resolve()
    start_age = int(payload["start_age"])
    end_age = int(payload["end_age"])
    n_simulations = int(payload.get("n_simulations", 500))
    seed = int(payload.get("seed", 42))

    canonical = payload["canonical_input"]
    profile = _canonical_to_stage_profile(canonical)

    models = _load_models_with_backcompat(model_artifact)
    result = simulate_biomarkers(
        models,
        profile,
        start_age,
        end_age,
        n_simulations=n_simulations,
        random_seed=seed,
    )

    summary_df = result["summary"].copy()
    if summary_df.empty:
        return {
            "startAge": start_age,
            "endAge": end_age,
            "trajectory": [],
        }

    summary_df["base_sigma"] = (summary_df["p95"] - summary_df["p05"]) / (2 * 1.645)
    summary_df["base_sigma"] = summary_df["base_sigma"].replace([np.inf, -np.inf], np.nan).fillna(0.5)

    ages = sorted({int(a) for a in summary_df["age"].tolist()})
    trajectory: list[dict[str, Any]] = []

    for age in ages:
        age_rows = summary_df[summary_df["age"] == age]
        biomarkers: dict[str, dict[str, float | None]] = {}

        for _, row in age_rows.iterrows():
            biomarker = str(row["biomarker"])
            biomarkers[biomarker] = {
                "mean": float(row["mean"]),
                "p05": float(row["p05"]) if pd.notna(row["p05"]) else None,
                "p50": float(row["p50"]) if pd.notna(row["p50"]) else None,
                "p95": float(row["p95"]) if pd.notna(row["p95"]) else None,
                "base_sigma": float(max(0.01, row["base_sigma"])),
                "sigma_total": float(max(0.01, row["base_sigma"])),
            }

        trajectory.append({
            "age": age,
            "biomarkers": biomarkers,
        })

    return {
        "startAge": start_age,
        "endAge": end_age,
        "trajectory": trajectory,
    }


def _discover_diseases(model_dir: Path) -> list[str]:
    diseases: list[str] = []
    for path in sorted(model_dir.glob("*.joblib")):
        name = path.name
        if name == "hearing_loss_model.joblib":
            diseases.append("hearing_loss")
            continue
        diseases.append(path.stem)
    return diseases


def _stage2(payload: dict[str, Any]) -> dict[str, Any]:
    model_dir = Path(payload["model_dir"]).resolve()
    diseases = payload.get("diseases") or _discover_diseases(model_dir)
    rows = payload["features_by_year"]

    engine = DiseaseRiskEngine(model_dir)

    output_rows: list[dict[str, Any]] = []
    for row in rows:
        age = _to_float(row.get("age"))
        if age is None:
            continue
        covariates = dict(row)
        covariates.pop("age", None)

        risk_map: dict[str, float] = {}
        for disease in diseases:
            # Stage 2 should emit per-year event risk (annual incidence).
            # Cumulative conversion is handled in the TS scenario runner.
            risk = engine.predict_annual_incidence(disease, age, covariates)
            risk_map[disease] = float(np.clip(risk, 0.0, 1.0))

        output_rows.append(
            {
                "age": float(age),
                "row_id": row.get("row_id"),
                "year_index": row.get("year_index"),
                "sample_index": row.get("sample_index"),
                "risks": risk_map,
            }
        )

    return {
        "diseases": diseases,
        "rows": output_rows,
    }


def _main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw)
    mode = payload.get("mode")

    if mode == "stage1":
        out = _stage1(payload)
    elif mode == "stage2":
        out = _stage2(payload)
    else:
        raise ValueError(f"Unsupported mode: {mode}")

    print(json.dumps(out))


if __name__ == "__main__":
    _main()
