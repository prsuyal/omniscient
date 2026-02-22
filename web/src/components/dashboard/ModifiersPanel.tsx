"use client";

import { InfoTooltip } from "~/components/ui/InfoTooltip";
import { BlockEquation, InlineEquation } from "~/components/ui/Equation";
import { formatDiseaseLabel } from "~/lib/diseaseLabels";

type ModifierCategory =
  | "breaking_negative_habits"
  | "positive_habits_non_medical"
  | "medication_prescribed"
  | "surgical_treatments";

type Modifier = {
  id: string;
  category: ModifierCategory;
  title: string;
  description: string;
  enabledByDefault?: boolean;
};

type ModifierImpact = {
  modifier_id: string;
  unified_index_delta: number;
  risk_delta_by_disease_at_horizon: Record<string, number>;
};

const CATEGORY_LABELS: Record<ModifierCategory, string> = {
  breaking_negative_habits: "Breaking Negative Habits",
  positive_habits_non_medical: "Positive Habits",
  medication_prescribed: "Medication / Prescribed",
  surgical_treatments: "Surgical Treatments",
};

export function ModifiersPanel({
  modifiers,
  modifierImpacts,
  activeModifierIds,
  selectedCategory,
  onCategoryChange,
  onToggle,
  isApplying = false,
}: {
  modifiers: Modifier[];
  modifierImpacts: ModifierImpact[];
  activeModifierIds: string[];
  selectedCategory: ModifierCategory | "all";
  onCategoryChange: (category: ModifierCategory | "all") => void;
  onToggle: (modifierId: string) => void;
  isApplying?: boolean;
}) {
  const impactByModifierId = Object.fromEntries(
    modifierImpacts.map((impact) => [impact.modifier_id, impact]),
  );
  const topImpactRanking = [...modifierImpacts]
    .filter((impact) => impact.unified_index_delta > 0)
    .sort((a, b) => b.unified_index_delta - a.unified_index_delta)
    .slice(0, 5);

  const visibleModifiers = modifiers.filter((modifier) => {
    if (selectedCategory === "all") return true;
    return modifier.category === selectedCategory;
  });

  return (
    <section className="rounded-2xl border border-white/20 bg-black/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 text-base font-semibold text-white">
          What-If Changes & Interventions
          <InfoTooltip
            title="How What-If Impact Is Calculated"
            trigger="icon"
            size="large"
            theme="teal"
          >
            <p>
              Each toggle creates a new what-if scenario. The system re-runs the forecast with that change and compares
              results against your current profile.
            </p>
            <p className="font-semibold text-teal-100">Risk impact at the final modeled age</p>
            <BlockEquation formula="\\Delta R_d=R^{baseline}_{d,final}-R^{scenario}_{d,final}" />
            <p>
              Positive values mean lower projected risk with the selected change.
            </p>
            <p className="font-semibold text-teal-100">Unified Health Index impact</p>
            <BlockEquation formula="\\Delta UHI=UHI^{scenario}-UHI^{baseline}" />
            <p>
              Positive values mean the change improves your overall index.
            </p>
            <p className="font-semibold text-teal-100">Top impact ranking</p>
            <p>
              The ranking list is sorted by the largest positive <InlineEquation formula="\\Delta UHI" />.
            </p>
          </InfoTooltip>
          {isApplying ? (
            <span className="rounded-full border border-amber-300/40 bg-amber-500/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-100">
              Applying
            </span>
          ) : null}
        </h2>
        <div className="flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={() => onCategoryChange("all")}
            className={`rounded border px-2 py-1 ${
              selectedCategory === "all" ? "border-emerald-300 bg-emerald-400/20" : "border-white/20"
            }`}
          >
            All
          </button>
          {(Object.keys(CATEGORY_LABELS) as ModifierCategory[]).map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => onCategoryChange(category)}
              className={`rounded border px-2 py-1 ${
                selectedCategory === category ? "border-emerald-300 bg-emerald-400/20" : "border-white/20"
              }`}
            >
              {CATEGORY_LABELS[category]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-white/15 bg-black/25 p-3">
        <h3 className="text-xs font-semibold tracking-wide text-white/80">
          Highest Positive Unified Health Index Impact
        </h3>
        {topImpactRanking.length > 0 ? (
          <ol className="mt-2 grid gap-1 text-xs text-white/80">
            {topImpactRanking.map((impact, index) => {
              const modifier = modifiers.find((row) => row.id === impact.modifier_id);
              return (
                <li key={impact.modifier_id} className="flex items-center justify-between rounded border border-white/10 bg-black/30 px-2 py-1">
                  <span>
                    {index + 1}. {modifier?.title ?? impact.modifier_id}
                  </span>
                  <span className="text-emerald-200">+{impact.unified_index_delta.toFixed(1)} points</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-2 text-xs text-white/60">
            Ranking appears after background modifier scenarios complete.
          </p>
        )}
      </div>

      <div className="mt-4 grid gap-2">
        {visibleModifiers.map((modifier) => {
          const isActive = activeModifierIds.includes(modifier.id);
          const impact = impactByModifierId[modifier.id] as ModifierImpact | undefined;
          const topDiseaseDelta = impact
            ? Object.entries(impact.risk_delta_by_disease_at_horizon).sort((a, b) => b[1] - a[1])[0]
            : null;

          return (
            <article key={modifier.id} className="rounded-lg border border-white/15 bg-black/30 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-white">{modifier.title}</h3>
                  <p className="mt-1 text-xs text-white/70">{modifier.description}</p>
                  <p className="mt-2 text-[11px] uppercase tracking-wide text-white/60">
                    {CATEGORY_LABELS[modifier.category]}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onToggle(modifier.id)}
                  className={`rounded px-3 py-1 text-xs font-medium ${
                    isActive ? "bg-emerald-400 text-black" : "border border-white/30 text-white"
                  }`}
                >
                  {isActive ? "Enabled" : "Enable"}
                </button>
              </div>

              {impact ? (
                <div className="mt-2 grid gap-1 text-xs text-white/75">
                  <div className="inline-flex items-center gap-1">
                    Unified Health Index change: {impact.unified_index_delta >= 0 ? "+" : ""}{impact.unified_index_delta.toFixed(1)}
                    <InfoTooltip
                      title="Unified Index Delta"
                      triggerLabel="How this is calculated"
                      body="This compares the Unified Health Index with this change turned on versus your current profile."
                      bullets={["$\\Delta UHI=UHI^{scenario}-UHI^{baseline}$"]}
                    />
                  </div>
                  {topDiseaseDelta ? (
                    <div className="inline-flex items-center gap-1">
                      Top risk reduction at horizon: {formatDiseaseLabel(topDiseaseDelta[0])} {topDiseaseDelta[1] >= 0 ? "-" : "+"}
                      {Math.abs(topDiseaseDelta[1] * 100).toFixed(1)}%
                      <InfoTooltip
                        title="Horizon Risk Reduction"
                        triggerLabel="How this is calculated"
                        body="For the strongest condition shift, this shows the end-of-horizon difference between your current profile and this scenario."
                        bullets={["$\\Delta R_d=R^{baseline}_{d,final}-R^{scenario}_{d,final}$"]}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
