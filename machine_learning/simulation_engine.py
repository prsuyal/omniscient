"""Reusable simulation engine for NHANES disease risk models."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

import joblib
import numpy as np
import pandas as pd


class DiseaseRiskEngine:
    def __init__(self, model_dir: str | Path | None = None):
        base = Path(model_dir) if model_dir is not None else Path(__file__).resolve().parent / "outputs" / "models"
        self.model_dir = base
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._patch_bspline_compat()

    def _patch_bspline_compat(self) -> None:
        try:
            from scipy.interpolate import BSpline
        except Exception:
            return

        def _get_coef(self: Any) -> Any:
            store = object.__getattribute__(self, "__dict__")
            if "_c" in store:
                return store["_c"]
            if "c" in store:
                return store["c"]
            return None

        def _get_knots(self: Any) -> Any:
            store = object.__getattribute__(self, "__dict__")
            if "_t" in store:
                return store["_t"]
            if "t" in store:
                return store["t"]
            return None

        def _set_coef(self: Any, value: Any) -> None:
            object.__getattribute__(self, "__dict__")["_c"] = value

        def _set_knots(self: Any, value: Any) -> None:
            object.__getattribute__(self, "__dict__")["_t"] = value

        def _asarray_compat(x: Any) -> Any:
            return np.asarray(x)

        BSpline.c = property(_get_coef, _set_coef)  # type: ignore[attr-defined]
        BSpline.t = property(_get_knots, _set_knots)  # type: ignore[attr-defined]
        if not isinstance(getattr(BSpline, "_c", None), property):
            BSpline._c = property(_get_coef, _set_coef)  # type: ignore[attr-defined]
        if not isinstance(getattr(BSpline, "_t", None), property):
            BSpline._t = property(_get_knots, _set_knots)  # type: ignore[attr-defined]
        if not hasattr(BSpline, "_asarray"):
            BSpline._asarray = staticmethod(_asarray_compat)  # type: ignore[attr-defined]

    def _load(self, disease: str) -> Dict[str, Any]:
        if disease not in self._cache:
            filename = "hearing_loss_model.joblib" if disease == "hearing_loss" else f"{disease}.joblib"
            path = self.model_dir / filename
            self._cache[disease] = joblib.load(path)
        return self._cache[disease]

    def _design(self, bundle: Dict[str, Any], row: Dict[str, Any]) -> pd.DataFrame:
        if "preprocess" in bundle:
            st = bundle["preprocess"]
            cont = bundle["continuous_features"]
            binary = bundle["binary_features"]
            cats = bundle["categorical_features"]
        else:
            st = bundle["state"]
            cont = bundle["continuous_cols"]
            binary = bundle["binary_cols"]
            cats = bundle["categorical_cols"]
        df = pd.DataFrame([row])

        medians = st["medians"]
        means = st["means"]
        stds = st["stds"]

        miss = pd.DataFrame(index=df.index)
        cont_scaled = pd.DataFrame(index=df.index)
        for c in cont:
            df[c] = pd.to_numeric(df.get(c), errors="coerce")
            miss[f"{c}__missing"] = df[c].isna().astype(float)
            filled = df[c].fillna(float(medians[c]))
            cont_scaled[c] = (filled - float(means[c])) / float(stds[c])

        age_filled = df["age"].fillna(float(medians["age"]))
        spline_values = st["spline_transformer"].transform(age_filled.to_numpy().reshape(-1, 1))
        spline = pd.DataFrame(spline_values, index=df.index, columns=st["spline_columns"])

        for c in cats:
            if c not in df.columns:
                df[c] = np.nan
        cat_df = df[cats].copy()
        for c in cats:
            cat_df[c] = cat_df[c].fillna("Unknown").astype(str)
        dummies = pd.get_dummies(cat_df, prefix=cats, dummy_na=False, dtype=float)
        dummies = dummies.reindex(columns=st["dummy_columns"], fill_value=0.0)

        bin_df = pd.DataFrame(index=df.index)
        for b in binary:
            vals = df[b] if b in df.columns else pd.Series(0.0, index=df.index)
            bin_df[b] = pd.to_numeric(vals, errors="coerce").fillna(0.0)

        sex_male = dummies["sex_Male"] if "sex_Male" in dummies.columns else pd.Series(0.0, index=df.index)
        inter = pd.DataFrame(index=df.index)
        inter["age_x_bmi"] = cont_scaled["age"] * cont_scaled["bmi"]
        inter["age_x_smoking"] = cont_scaled["age"] * bin_df["current_smoker"]
        inter["sex_x_bmi"] = sex_male * cont_scaled["bmi"]

        cont_no_age = cont_scaled.drop(columns=["age"])
        X = pd.concat([spline, cont_no_age, miss, bin_df, dummies, inter], axis=1)
        X = X.reindex(columns=st["final_columns"], fill_value=0.0)
        return X

    def predict_prevalence(self, disease: str, age: float, covariates: Dict[str, Any] | None = None) -> float:
        bundle = self._load(disease)
        model = bundle["model"]
        row = dict(covariates or {})
        row["age"] = float(age)
        X = self._design(bundle, row)
        return float(model.predict_proba(X)[:, 1][0])

    def predict_annual_incidence(self, disease: str, age: float, covariates: Dict[str, Any] | None = None) -> float:
        p_t = self.predict_prevalence(disease, age, covariates)
        p_t1 = self.predict_prevalence(disease, age + 1.0, covariates)
        return float(max(0.0, (p_t1 - p_t) / max(1e-6, 1.0 - p_t)))
