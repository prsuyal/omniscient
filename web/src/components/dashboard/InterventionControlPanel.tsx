import {
  INTERVENTION_CATEGORIES,
  interventions,
  riskForecasts,
} from "~/data/mockMedicalData";
import { evidenceLabel, formatDeltaValue } from "~/lib/simulation";
import type {
  Intervention,
  InterventionCategory,
  RiskCategory,
} from "~/types/medical";

interface InterventionControlPanelProps {
  selectedRisk: RiskCategory | null;
  activeInterventionIds: string[];
  categoryFilter: InterventionCategory | "all";
  onCategoryFilterChange: (filter: InterventionCategory | "all") => void;
  onToggleIntervention: (interventionId: string) => void;
  conflictLabels: string[];
}

const riskLabelById = Object.fromEntries(riskForecasts.map((risk) => [risk.id, risk.shortLabel]));

const orderInterventions = (
  items: Intervention[],
  selectedRisk: RiskCategory | null,
  activeSet: Set<string>,
) => {
  if (!selectedRisk) {
    return [...items].sort((a, b) => Number(activeSet.has(b.id)) - Number(activeSet.has(a.id)));
  }

  return [...items].sort((a, b) => {
    const activeBoost = Number(activeSet.has(b.id)) - Number(activeSet.has(a.id));
    if (activeBoost !== 0) {
      return activeBoost;
    }

    const aEffect = Math.abs(a.effects[selectedRisk] ?? 0);
    const bEffect = Math.abs(b.effects[selectedRisk] ?? 0);
    return bEffect - aEffect;
  });
};

export function InterventionControlPanel({
  selectedRisk,
  activeInterventionIds,
  categoryFilter,
  onCategoryFilterChange,
  onToggleIntervention,
  conflictLabels,
}: InterventionControlPanelProps) {
  const activeSet = new Set(activeInterventionIds);

  const filtered = interventions.filter(
    (intervention) => categoryFilter === "all" || intervention.category === categoryFilter,
  );

  const ordered = orderInterventions(filtered, selectedRisk, activeSet);

  return (
    <section className="dashboard-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Intervention Simulator</h2>
          <p className="text-sm text-neutral-100/70">
            Toggle interventions to instantly recalculate body heat, risk curves, and unified index.
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {INTERVENTION_CATEGORIES.map((category) => (
          <button
            className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
              categoryFilter === category
                ? "border-[#57EBC0] bg-[#57EBC0]/15 text-white"
                : "border-white/20 text-white/80 hover:border-white/45 hover:bg-white/10"
            }`}
            key={category}
            onClick={() => onCategoryFilterChange(category)}
            type="button"
          >
            {category}
          </button>
        ))}
      </div>

      {conflictLabels.length > 0 ? (
        <div className="mt-4 space-y-2 rounded-2xl border border-[#F18A4C]/45 bg-[#F18A4C]/12 p-3 text-sm text-[#f6d7c2]">
          {conflictLabels.map((label) => (
            <p key={label}>{label}</p>
          ))}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        {ordered.map((intervention) => {
          const isActive = activeSet.has(intervention.id);
          const selectedRiskDelta = selectedRisk ? intervention.effects[selectedRisk] ?? 0 : 0;
          const increasesSelectedRisk = selectedRiskDelta > 0;

          const topEffects = Object.entries(intervention.effects)
            .sort(([, aDelta], [, bDelta]) => Math.abs(bDelta ?? 0) - Math.abs(aDelta ?? 0))
            .slice(0, 3);

          const hasCompatibilityIssue = (intervention.incompatibleWith ?? []).some((id) => activeSet.has(id));

          return (
            <article
              className={`rounded-2xl border p-4 transition ${
                isActive
                  ? "border-[#57EBC0]/65 bg-[#57EBC0]/12"
                  : "border-white/12 bg-black/20 hover:border-white/25"
              }`}
              key={intervention.id}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm text-white">{intervention.title}</h3>
                  <p className="mt-1 text-xs text-neutral-100/70">{intervention.summary}</p>
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
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded-full border border-white/15 px-2 py-0.5 text-white/75">
                  {intervention.category}
                </span>
                <span className="rounded-full border border-white/15 px-2 py-0.5 text-white/75">
                  {evidenceLabel[intervention.evidence]}
                </span>
                {hasCompatibilityIssue ? (
                  <span className="rounded-full border border-[#F18A4C]/70 px-2 py-0.5 text-[#f8cfb5]">
                    Compatibility warning
                  </span>
                ) : null}
              </div>

              {selectedRisk ? (
                <p
                  className={`mt-3 text-xs ${
                    increasesSelectedRisk ? "text-[#F18A4C]" : "text-[#57EBC0]"
                  }`}
                >
                  {riskLabelById[selectedRisk]} impact: {formatDeltaValue(selectedRiskDelta, selectedRisk)}
                </p>
              ) : null}

              <ul className="mt-3 space-y-1 text-xs text-neutral-100/78">
                {topEffects.map(([riskId, delta]) => {
                  const key = riskId as RiskCategory;
                  return (
                    <li className="flex items-center justify-between" key={`${intervention.id}-${riskId}`}>
                      <span>{riskLabelById[key]}</span>
                      <span className={(delta ?? 0) <= 0 ? "text-[#57EBC0]" : "text-[#F18A4C]"}>
                        {formatDeltaValue(delta ?? 0, key)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </article>
          );
        })}
      </div>

      {ordered.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-white/25 bg-black/20 p-4 text-sm text-neutral-100/70">
          No interventions match this filter. Switch category filters to explore more options.
        </div>
      ) : null}
    </section>
  );
}
