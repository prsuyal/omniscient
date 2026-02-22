"use client";

import { InfoTooltip } from "~/components/ui/InfoTooltip";
import { BlockEquation } from "~/components/ui/Equation";
import { formatDiseaseLabel } from "~/lib/diseaseLabels";

type UnifiedIndex = {
  value: number;
  behavior_score: number;
  biomarker_score: number;
  predicted_risk_score: number;
  top3_preventable_risks: Array<{
    disease: string;
    preventable_fraction: number;
    baseline_risk: number;
    best_risk: number;
  }>;
};

export function UnifiedIndexCard({
  unifiedIndex,
  isUpdating = false,
}: {
  unifiedIndex: UnifiedIndex | null | undefined;
  isUpdating?: boolean;
}) {
  if (!unifiedIndex) {
    return (
      <article className="rounded-2xl border border-white/20 bg-black/20 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-white/80">Unified Health Index</h2>
        <p className="mt-2 text-sm text-white/65">Run a simulation to calculate the index.</p>
      </article>
    );
  }

  return (
    <article className="rounded-2xl border border-emerald-300/30 bg-emerald-950/20 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-emerald-100">Unified Health Index</h2>
        <InfoTooltip
          title="How The Unified Health Index Is Calculated"
          trigger="icon"
          size="large"
          theme="emerald"
        >
          <p>
            This score combines your day-to-day habits, your biomarker outlook, and your long-term risk outlook into
            one number from 0 to 100. Higher is better.
          </p>
          <p className="font-semibold text-emerald-100">1) Habit Score (35%)</p>
          <p>We score exercise, sleep, alcohol, and diet on a 0 to 1 scale, then take a weighted average.</p>
          <BlockEquation formula="S_{habits}=0.30S_{exercise}+0.25S_{sleep}+0.20S_{alcohol}+0.25S_{diet}" />
          <p className="font-semibold text-emerald-100">2) Biomarker Score (35%)</p>
          <p>We score blood pressure, A1c, LDL, HDL, BMI, and kidney function, then combine them with weights.</p>
          <BlockEquation formula="S_{bio}=0.20S_{SBP}+0.20S_{HbA1c}+0.18S_{LDL}+0.12S_{HDL}+0.15S_{BMI}+0.15S_{eGFR}" />
          <p className="font-semibold text-emerald-100">3) Risk Outlook Score (30%)</p>
          <p>We average all forecasted disease probabilities across ages and diseases. Lower risk means a higher score.</p>
          <BlockEquation formula="\\overline{R}=\\frac{1}{N}\\sum_{i=1}^{N}R_i" />
          <p className="font-semibold text-emerald-100">Final score</p>
          <BlockEquation formula="UHI=100\\times\\left(0.35S_{habits}+0.35S_{bio}+0.30S_{risk}\\right)" />
          <p className="font-semibold text-emerald-100">Preventable risk fraction (per disease)</p>
          <BlockEquation formula="PF_d=\\max\\left(0,\\frac{R^{baseline}_d-R^{best}_d}{R^{baseline}_d}\\right)" />
          <p>
            In plain language: this tells you how much of a disease risk could be reduced if the best tested changes
            were applied.
          </p>
        </InfoTooltip>
        {isUpdating ? (
          <span className="rounded-full border border-amber-300/40 bg-amber-500/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-100">
            Updating
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-4xl font-semibold text-white">{unifiedIndex.value.toFixed(1)}</p>
      <p className="text-xs text-white/70">0 = worst conceptual anchor, 100 = best achievable anchor</p>

      <div className="mt-4 grid gap-2 text-xs text-white/80">
        <div className="flex items-center justify-between">
          <InfoTooltip
            title="Habit Score"
            triggerLabel="Habit score"
            body="This is a summary of your current routine. More activity, healthier sleep range, better diet quality, and lower alcohol all push this score up."
            bullets={[
              "Each item is converted to a 0-1 scale before combining.",
              "$S_{habits}=0.30S_{exercise}+0.25S_{sleep}+0.20S_{alcohol}+0.25S_{diet}$",
            ]}
          />
          <span>{Math.round(unifiedIndex.behavior_score * 100)}%</span>
        </div>
        <div className="flex items-center justify-between">
          <InfoTooltip
            title="Biomarker Score"
            triggerLabel="Biomarker score"
            body="This shows how favorable your key health measurements look at the forecast horizon. Better blood pressure, cholesterol, blood sugar, BMI, and kidney function improve it."
            bullets={["$S_{bio}=0.20S_{SBP}+0.20S_{HbA1c}+0.18S_{LDL}+0.12S_{HDL}+0.15S_{BMI}+0.15S_{eGFR}$"]}
          />
          <span>{Math.round(unifiedIndex.biomarker_score * 100)}%</span>
        </div>
        <div className="flex items-center justify-between">
          <InfoTooltip
            title="Predicted-Risk Score"
            triggerLabel="Predicted-risk score"
            body="This converts your overall long-term disease risk into a positive score. Lower forecasted risk leads to a higher value here."
            bullets={[
              "$\\overline{R}=\\frac{1}{N}\\sum_{i=1}^{N}R_i$",
              "Lower $\\overline{R}$ maps to a higher score.",
            ]}
          />
          <span>{Math.round(unifiedIndex.predicted_risk_score * 100)}%</span>
        </div>
      </div>

      <div className="mt-4">
        <h3 className="text-xs font-semibold tracking-wide text-white/80">Top 3 Preventable Risks</h3>
        <InfoTooltip
          className="mt-1"
          title="How Preventable Risk Is Ranked"
          triggerLabel="How this ranking is calculated"
          body="For each condition, we compare your baseline end-of-horizon risk with the best risk seen in the tested scenarios. A bigger gap means more risk appears preventable."
          bullets={["$PF_d=\\max\\left(0,\\frac{R^{baseline}_d-R^{best}_d}{R^{baseline}_d}\\right)$"]}
        />
        <ul className="mt-2 grid gap-2">
          {unifiedIndex.top3_preventable_risks.map((risk) => (
            <li key={risk.disease} className="rounded-lg border border-white/15 bg-black/30 p-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-white">{formatDiseaseLabel(risk.disease)}</span>
                <span className="text-emerald-200">{(risk.preventable_fraction * 100).toFixed(1)}% preventable</span>
              </div>
              <div className="mt-1 text-white/70">
                baseline {(risk.baseline_risk * 100).toFixed(1)}% → best {(risk.best_risk * 100).toFixed(1)}%
              </div>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
