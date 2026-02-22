"use client";

import { InfoTooltip } from "~/components/ui/InfoTooltip";
import { BlockEquation } from "~/components/ui/Equation";
import { formatDiseaseLabel } from "~/lib/diseaseLabels";

type Confidence = {
  overall_confidence: number;
  missingness_score: number;
  missingness_recommendations?: Array<{
    field_path: string;
    label: string;
    prompt: string;
    relevant_diseases: string[];
  }>;
  biomarker_confidence: Record<string, number>;
  disease_confidence: Record<string, number>;
};

export function ConfidenceCard({
  confidence,
  modelAucs = {},
  isUpdating = false,
}: {
  confidence: Confidence | null | undefined;
  modelAucs?: Record<string, number>;
  isUpdating?: boolean;
}) {
  if (!confidence) {
    return (
      <article className="rounded-2xl border border-white/20 bg-black/20 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-white/80">Model Confidence</h2>
        <p className="mt-2 text-sm text-white/65">Confidence metrics appear after simulation completes.</p>
      </article>
    );
  }

  const sortedDiseaseConfidence = Object.entries(confidence.disease_confidence).sort((a, b) => b[1] - a[1]);
  const recommendationBullets = (confidence.missingness_recommendations ?? [])
    .slice(0, 6)
    .map((item) => `${item.label}: ${item.prompt}`);
  const fallbackRecommendation =
    confidence.missingness_score >= 0.85
      ? "Most key fields are present. Add more recent labs/vitals to further tighten uncertainty."
      : confidence.missingness_score >= 0.6
        ? "Some key fields are still missing. Add recent labs and lifestyle details to improve confidence."
        : "Many important fields are missing. Add baseline labs, vitals, and behavior inputs to raise confidence.";

  return (
    <article className="rounded-2xl border border-cyan-300/30 bg-cyan-950/20 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-cyan-100">Overall Confidence</h2>
        <InfoTooltip
          title="How Overall Confidence Is Calculated"
          trigger="icon"
          size="large"
          theme="cyan"
        >
          <p>
            Confidence tells you how reliable the forecast is likely to be for your profile. It blends data
            completeness, biomarker reliability, and disease-model quality.
          </p>
          <p className="font-semibold text-cyan-100">1) Profile completeness</p>
          <BlockEquation formula="M=\\frac{\\#\\text{completed fields}}{\\#\\text{required fields}}" />
          <p className="font-semibold text-cyan-100">2) Biomarker confidence</p>
          <BlockEquation formula="Q_{metric}=0.35Q_W+0.35Q_{RMSE}+0.30Q_{var}" />
          <BlockEquation formula="Q_{unc}=1-\\mathrm{clip}\\left(\\frac{width}{maxAcceptable},0,1\\right)" />
          <BlockEquation formula="C_b=40+60\\times\\left(0.45Q_{metric}+0.35Q_{unc}+0.20M\\right)" />
          <p className="font-semibold text-cyan-100">3) Disease confidence</p>
          <BlockEquation formula="R_d=0.70M+0.30U_d" />
          <BlockEquation formula="C_d=(100\\times AUC_d)\\times\\left(0.68+0.32R_d\\right)" />
          <p className="font-semibold text-cyan-100">4) Final overall confidence</p>
          <BlockEquation formula="C_{overall}=0.82\\overline{C_d}+0.12\\overline{C_b}+0.06(100M)" />
          <p>
            In plain language: confidence rises when your data is more complete, biomarker forecasts are tighter, and
            disease models are stronger.
          </p>
        </InfoTooltip>
        {isUpdating ? (
          <span className="rounded-full border border-amber-300/40 bg-amber-500/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-100">
            Updating
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-4xl font-semibold text-white">{confidence.overall_confidence.toFixed(1)}</p>
      <p className="inline-flex items-center gap-1 text-xs text-white/70">
        Data completeness score: {(confidence.missingness_score * 100).toFixed(1)}%
        <InfoTooltip
          title="How To Improve Data Completeness"
          triggerLabel="What should I add?"
          body="Adding these missing details can raise confidence by giving the model a fuller picture of your health profile."
          bullets={
            recommendationBullets.length > 0
              ? recommendationBullets
              : [fallbackRecommendation]
          }
        />
      </p>

      <div className="mt-4">
        <h3 className="inline-flex items-center gap-1 text-xs font-semibold tracking-wide text-white/80">
          Confidence By Condition
          <InfoTooltip
            title="How Condition-Level Confidence Works"
            triggerLabel="How this is computed"
            body="Each condition blends model quality (AUC), your profile completeness, and confidence from the biomarkers most related to that condition."
            bullets={sortedDiseaseConfidence.map(([disease, score]) => {
              const auc = modelAucs[disease];
              return `${formatDiseaseLabel(disease)}: confidence ${score.toFixed(1)}%, model AUC ${auc != null ? auc.toFixed(2) : "n/a"}`;
            })}
          />
        </h3>
        <ul className="mt-2 grid gap-1 text-xs">
          {sortedDiseaseConfidence.map(([disease, score]) => {
            const auc = modelAucs[disease];
            return (
              <li key={disease} className="flex items-center justify-between rounded border border-white/15 bg-black/30 px-2 py-1">
                <span className="text-white">{formatDiseaseLabel(disease)}</span>
                <span className="text-cyan-200">{score.toFixed(1)}%{auc != null ? ` (AUC ${auc.toFixed(2)})` : ""}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </article>
  );
}
