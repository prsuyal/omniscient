import { riskForecasts } from "~/data/mockMedicalData";
import { evidenceLabel, formatDeltaValue } from "~/lib/simulation";
import type { InterventionImpactScore, PreventableRiskInsight } from "~/types/medical";

interface SummarySectionProps {
  selectedAge: number;
  unified: {
    baseline: number;
    modified: number;
  };
  topPreventableRisks: PreventableRiskInsight[];
  strongestInterventions: InterventionImpactScore[];
}

const riskLabelById = Object.fromEntries(riskForecasts.map((risk) => [risk.id, risk.shortLabel]));

export function SummarySection({
  selectedAge,
  unified,
  topPreventableRisks,
  strongestInterventions,
}: SummarySectionProps) {
  const unifiedDelta = unified.modified - unified.baseline;

  return (
    <section className="dashboard-panel grid gap-6 p-6 lg:grid-cols-[320px_1fr_1fr]">
      <div className="relative overflow-hidden rounded-3xl border border-white/15 bg-white/5 p-5">
        <p className="text-xs uppercase tracking-[0.24em] text-neutral-200/70">Unified Health Index</p>
        <p className="mt-2 text-sm text-neutral-100/70">Projected age {selectedAge}</p>

        <div
          className="relative mt-5 h-44 w-44 rounded-full"
          style={{
            background: `conic-gradient(var(--accent-clinical) ${unified.modified * 3.6}deg, rgba(255,255,255,0.12) 0deg)`,
          }}
          aria-label={`Unified health index ${Math.round(unified.modified)} out of 100`}
          role="img"
        >
          <div className="absolute inset-[14px] rounded-full border border-white/20 bg-[#2A2727]" />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-4xl font-semibold text-white">{Math.round(unified.modified)}</span>
            <span className="text-xs uppercase tracking-[0.18em] text-neutral-100/75">Composite</span>
          </div>
          <div
            className="absolute inset-0 rounded-full border border-white/25"
            style={{
              transform: `rotate(${unified.baseline * 3.6}deg)`,
            }}
          />
        </div>

        <div className="mt-4 inline-flex items-center rounded-full border border-white/20 px-3 py-1 text-xs text-white/85">
          {unifiedDelta >= 0 ? "Improved" : "Lower"} {Math.abs(unifiedDelta).toFixed(1)} points vs baseline
        </div>
      </div>

      <div className="rounded-3xl border border-white/15 bg-white/[0.04] p-5">
        <h2 className="text-base font-semibold text-white">Most Preventable Risks</h2>
        <p className="mt-1 text-sm text-neutral-100/70">
          Highest avoidable burden if current intervention set is maintained.
        </p>
        <div className="mt-4 space-y-3">
          {topPreventableRisks.map((insight) => (
            <article
              className="rounded-2xl border border-white/10 bg-black/15 px-4 py-3"
              key={insight.category}
            >
              <p className="text-sm text-white">{riskLabelById[insight.category] ?? insight.label}</p>
              <p className="mt-1 text-xs uppercase tracking-[0.12em] text-[#57EBC0]">
                {formatDeltaValue(-insight.preventedAmount, insight.category)} potential reduction
              </p>
            </article>
          ))}
        </div>
      </div>

      <div className="rounded-3xl border border-white/15 bg-white/[0.04] p-5">
        <h2 className="text-base font-semibold text-white">Strongest Next Interventions</h2>
        <p className="mt-1 text-sm text-neutral-100/70">
          Ranked by modeled gain to your current simulated trajectory.
        </p>

        <div className="mt-4 space-y-3">
          {strongestInterventions.map((item) => (
            <article
              className="rounded-2xl border border-white/10 bg-black/15 px-4 py-3"
              key={item.interventionId}
            >
              <div className="flex items-start justify-between gap-4">
                <h3 className="text-sm text-white">{item.title}</h3>
                <span className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-white/75">
                  {item.category}
                </span>
              </div>
              <p className="mt-2 text-xs text-neutral-100/70">{evidenceLabel[item.evidence]}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
