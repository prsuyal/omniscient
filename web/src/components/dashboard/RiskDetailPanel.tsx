import { interventions, riskForecasts } from "~/data/mockMedicalData";
import { evidenceLabel, formatDeltaValue } from "~/lib/simulation";
import type { RiskCategory, SeriesPoint } from "~/types/medical";

import { ConfidenceMeter } from "./ConfidenceMeter";
import { FeatureImportanceChart } from "./FeatureImportanceChart";
import { RiskTrendChart } from "./RiskTrendChart";

interface RiskDetailPanelProps {
  selectedRisk: RiskCategory | null;
  selectedAge: number;
  riskSeries: Record<RiskCategory, SeriesPoint[]>;
  activeInterventionIds: string[];
  onToggleIntervention: (interventionId: string) => void;
  onClose: () => void;
}

export function RiskDetailPanel({
  selectedRisk,
  selectedAge,
  riskSeries,
  activeInterventionIds,
  onToggleIntervention,
  onClose,
}: RiskDetailPanelProps) {
  if (!selectedRisk) {
    return (
      <aside className="dashboard-panel h-fit p-6">
        <h2 className="text-xl font-semibold text-white">Risk Popout</h2>
        <p className="mt-2 text-sm text-neutral-100/70">
          Select a body region to open detailed forecasts, confidence, feature importance, and targeted interventions.
        </p>
      </aside>
    );
  }

  const riskMeta = riskForecasts.find((risk) => risk.id === selectedRisk);

  if (!riskMeta) {
    return (
      <aside className="dashboard-panel h-fit p-6">
        <p className="text-sm text-neutral-100/70">Risk metadata unavailable for this region.</p>
      </aside>
    );
  }

  const series = riskSeries[selectedRisk] ?? [];
  const selectedPoint = series.find((point) => point.age === selectedAge);

  const relatedInterventions = interventions.filter(
    (intervention) => (intervention.effects[selectedRisk] ?? 0) !== 0,
  );

  const lowRiskState =
    selectedPoint && riskMeta.unit === "percent"
      ? selectedPoint.baseline < 12 && selectedPoint.modified < 12
      : selectedPoint
        ? selectedPoint.baseline < 5000 && selectedPoint.modified < 5000
        : false;

  return (
    <aside className="dashboard-panel relative h-fit p-5">
      <button
        aria-label="Close detail panel"
        className="absolute right-4 top-4 rounded-full border border-white/25 px-2 py-0.5 text-xs text-white/80 transition hover:border-white/50 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        onClick={onClose}
        type="button"
      >
        Close
      </button>

      <h2 className="pr-16 text-xl font-semibold text-white">{riskMeta.label}</h2>
      <p className="mt-1 text-sm text-neutral-100/70">{riskMeta.bodyLabel} projection focus</p>

      {lowRiskState ? (
        <div className="mt-4 rounded-2xl border border-[#57EBC0]/45 bg-[#57EBC0]/10 p-3 text-sm text-[#dcfff5]">
          Low-risk state: baseline and modified projections remain low at this age.
        </div>
      ) : null}

      <div className="mt-4 space-y-4">
        <RiskTrendChart category={selectedRisk} selectedAge={selectedAge} series={series} />

        <div className="grid gap-4 lg:grid-cols-2">
          <ConfidenceMeter confidence={riskMeta.confidence} />

          <article className="rounded-2xl border border-white/12 bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-neutral-100/70">Model explanation</p>
            <p className="mt-2 text-sm leading-relaxed text-neutral-100/85">{riskMeta.explanation}</p>
          </article>
        </div>

        <FeatureImportanceChart features={riskMeta.featureImportance} />

        <article className="rounded-2xl border border-white/12 bg-black/20 p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-neutral-100/70">
            Available interventions for {riskMeta.shortLabel}
          </p>

          {relatedInterventions.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {relatedInterventions.map((intervention) => {
                const isActive = activeInterventionIds.includes(intervention.id);
                const riskDelta = intervention.effects[selectedRisk] ?? 0;

                return (
                  <li
                    className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/20 p-3"
                    key={intervention.id}
                  >
                    <div>
                      <p className="text-sm text-white">{intervention.title}</p>
                      <p className="text-xs text-neutral-100/70">{evidenceLabel[intervention.evidence]}</p>
                      <p
                        className={`mt-1 text-xs ${
                          riskDelta <= 0 ? "text-[#57EBC0]" : "text-[#F18A4C]"
                        }`}
                      >
                        {formatDeltaValue(riskDelta, selectedRisk)} projected on this risk
                      </p>
                    </div>

                    <button
                      aria-label={`${isActive ? "Disable" : "Enable"} ${intervention.title}`}
                      aria-pressed={isActive}
                      className={`rounded-full border px-3 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                        isActive
                          ? "border-[#57EBC0] bg-[#57EBC0]/20 text-white"
                          : "border-white/25 text-white/80 hover:border-white/55 hover:bg-white/10"
                      }`}
                      onClick={() => onToggleIntervention(intervention.id)}
                      type="button"
                    >
                      {isActive ? "Active" : "Activate"}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mt-3 rounded-xl border border-dashed border-white/25 bg-black/20 p-3 text-sm text-neutral-100/70">
              No targeted interventions are currently available for this risk stream.
            </div>
          )}
        </article>
      </div>
    </aside>
  );
}
