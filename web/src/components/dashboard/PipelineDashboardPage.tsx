"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { STAGE2_AUC_BY_DISEASE } from "~/lib/modelQuality";
import { ConfidenceCard } from "~/components/dashboard/ConfidenceCard";
import { ModifiersPanel } from "~/components/dashboard/ModifiersPanel";
import { RiskCharts } from "~/components/dashboard/RiskCharts";
import { UnifiedIndexCard } from "~/components/dashboard/UnifiedIndexCard";
import { InfoTooltip } from "~/components/ui/InfoTooltip";
import { trpc } from "~/trpc/react";

type Stage2Output = {
  diseases: string[];
  years: Array<{
    age: number;
    deterministic: Record<string, number>;
    uncertainty: Record<string, { mean: number; median: number; p05: number; p95: number }>;
  }>;
};

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

type Confidence = {
  overall_confidence: number;
  missingness_score: number;
  missingness_recommendations: Array<{
    field_path: string;
    label: string;
    prompt: string;
    relevant_diseases: string[];
  }>;
  biomarker_confidence: Record<string, number>;
  disease_confidence: Record<string, number>;
};

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

type ScenarioComparison = {
  active_modifier_ids: string[];
  stage2: Stage2Output;
  unified_index: UnifiedIndex;
  confidence: Confidence;
  risk_delta_by_disease_at_horizon: Record<string, number>;
  unified_index_delta: number;
};

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
};

const asArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) return [];
  return value;
};

const asString = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
};

const asModifiers = (value: unknown): Modifier[] => {
  return asArray(value)
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      id: asString(item.id),
      category: (item.category as ModifierCategory) ?? "positive_habits_non_medical",
      title: asString(item.title, "Untitled"),
      description: asString(item.description),
      enabledByDefault: Boolean(item.enabledByDefault),
    }))
    .filter((modifier) => modifier.id.length > 0);
};

const asModifierImpacts = (value: unknown): ModifierImpact[] => {
  return asArray(value)
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      modifier_id: asString(item.modifier_id),
      unified_index_delta: Number(item.unified_index_delta ?? 0),
      risk_delta_by_disease_at_horizon:
        (asObject(item.risk_delta_by_disease_at_horizon) as Record<string, number>) ?? {},
    }))
    .filter((impact) => impact.modifier_id.length > 0);
};

const asStage2 = (value: unknown): Stage2Output | null => {
  const row = asObject(value);
  if (!row) return null;

  const diseases = asArray(row.diseases).map((disease) => asString(disease));
  const years = asArray(row.years)
    .map((yearRaw) => asObject(yearRaw))
    .filter((year): year is Record<string, unknown> => !!year)
    .map((year) => ({
      age: Number(year.age ?? 0),
      deterministic: (asObject(year.deterministic) as Record<string, number>) ?? {},
      uncertainty:
        (asObject(year.uncertainty) as Record<
          string,
          { mean: number; median: number; p05: number; p95: number }
        >) ?? {},
    }));

  if (diseases.length === 0 || years.length === 0) return null;
  return { diseases, years };
};

const asUnifiedIndex = (value: unknown): UnifiedIndex | null => {
  const row = asObject(value);
  if (!row) return null;

  return {
    value: Number(row.value ?? 0),
    behavior_score: Number(row.behavior_score ?? 0),
    biomarker_score: Number(row.biomarker_score ?? 0),
    predicted_risk_score: Number(row.predicted_risk_score ?? 0),
    top3_preventable_risks: asArray(row.top3_preventable_risks)
      .map((riskRaw) => asObject(riskRaw))
      .filter((risk): risk is Record<string, unknown> => !!risk)
      .map((risk) => ({
        disease: asString(risk.disease),
        preventable_fraction: Number(risk.preventable_fraction ?? 0),
        baseline_risk: Number(risk.baseline_risk ?? 0),
        best_risk: Number(risk.best_risk ?? 0),
      })),
  };
};

const asConfidence = (value: unknown): Confidence | null => {
  const row = asObject(value);
  if (!row) return null;

  const recommendations = asArray(row.missingness_recommendations)
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      field_path: asString(item.field_path),
      label: asString(item.label),
      prompt: asString(item.prompt),
      relevant_diseases: asArray(item.relevant_diseases).map((disease) => asString(disease)),
    }))
    .filter((item) => item.field_path.length > 0);

  return {
    overall_confidence: Number(row.overall_confidence ?? 0),
    missingness_score: Number(row.missingness_score ?? 0),
    missingness_recommendations: recommendations,
    biomarker_confidence: (asObject(row.biomarker_confidence) as Record<string, number>) ?? {},
    disease_confidence: (asObject(row.disease_confidence) as Record<string, number>) ?? {},
  };
};

const asScenarioComparison = (value: unknown): ScenarioComparison | null => {
  const row = asObject(value);
  if (!row) return null;

  const stage2 = asStage2(row.stage2);
  const unified = asUnifiedIndex(row.unified_index);
  const confidence = asConfidence(row.confidence);
  if (!stage2 || !unified || !confidence) return null;

  return {
    active_modifier_ids: asArray(row.active_modifier_ids).map((id) => asString(id)),
    stage2,
    unified_index: unified,
    confidence,
    risk_delta_by_disease_at_horizon:
      (asObject(row.risk_delta_by_disease_at_horizon) as Record<string, number>) ?? {},
    unified_index_delta: Number(row.unified_index_delta ?? 0),
  };
};

const sortedUniqueIds = (ids: string[]): string[] => [...new Set(ids)].sort();

const sameStringArray = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export function PipelineDashboardPage() {
  const searchParams = useSearchParams();
  const runIdFromQuery = searchParams.get("run");

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeModifierIds, setActiveModifierIds] = useState<string[]>([]);
  const [modifierCategory, setModifierCategory] = useState<ModifierCategory | "all">("all");
  const [comparison, setComparison] = useState<ScenarioComparison | null>(null);
  const [pendingModifierKey, setPendingModifierKey] = useState<string | null>(null);
  const [updateFreeform, setUpdateFreeform] = useState("");
  const [updateNutrition, setUpdateNutrition] = useState("");
  const [modifiersInitialized, setModifiersInitialized] = useState(false);
  const initializedRunIdRef = useRef<string | null>(null);
  const queryRunInitializedRef = useRef(false);

  const runsQuery = trpc.simulation.listRuns.useQuery(undefined, {
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (queryRunInitializedRef.current) return;
    if (!runIdFromQuery) return;
    setActiveRunId(runIdFromQuery);
    queryRunInitializedRef.current = true;
  }, [runIdFromQuery]);

  const selectedRun = useMemo(() => {
    const runs = runsQuery.data ?? [];
    if (activeRunId) {
      return runs.find((run) => run.id === activeRunId) ?? null;
    }
    return runs[0] ?? null;
  }, [activeRunId, runsQuery.data]);

  const recalculateRun = trpc.simulation.recalculateFromFreeformUpdate.useMutation({
    onSuccess() {
      setUpdateFreeform("");
      setUpdateNutrition("");
      void runsQuery.refetch();
      setComparison(null);
      setPendingModifierKey(null);
    },
  });

  const compareScenario = trpc.simulation.compareScenario.useMutation();

  const modifiers = useMemo(() => asModifiers(selectedRun?.modifiers), [selectedRun?.modifiers]);
  const modifierImpacts = useMemo(
    () => asModifierImpacts(selectedRun?.modifierImpacts),
    [selectedRun?.modifierImpacts],
  );

  const baselineStage2 = useMemo(() => asStage2(selectedRun?.stage2Output), [selectedRun?.stage2Output]);
  const baselineUnified = useMemo(
    () => asUnifiedIndex(selectedRun?.unifiedHealthIndex),
    [selectedRun?.unifiedHealthIndex],
  );
  const baselineConfidence = useMemo(
    () => asConfidence(selectedRun?.confidenceScores),
    [selectedRun?.confidenceScores],
  );
  const baseScenarioComparison = useMemo(
    () => asScenarioComparison(selectedRun?.baseScenarioComparison),
    [selectedRun?.baseScenarioComparison],
  );
  const normalizedActiveModifierIds = useMemo(
    () => sortedUniqueIds(activeModifierIds),
    [activeModifierIds],
  );
  const activeModifierKey = normalizedActiveModifierIds.join("|");
  const selectedRunId = selectedRun?.id ?? null;
  const selectedRunStatus = selectedRun?.status ?? null;
  useEffect(() => {
    if (!selectedRunId) return;
    if (initializedRunIdRef.current === selectedRunId) return;

    initializedRunIdRef.current = selectedRunId;

    const defaults = sortedUniqueIds(
      modifiers
        .filter((modifier) => modifier.enabledByDefault)
        .map((modifier) => modifier.id),
    );
    setActiveModifierIds(defaults);
    setComparison(null);
    setPendingModifierKey(null);
    setModifiersInitialized(false);
  }, [modifiers, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || selectedRunStatus !== "COMPLETED") return;
    if (activeModifierKey.length === 0) return;

    let cancelled = false;
    setPendingModifierKey(activeModifierKey);

    void compareScenario
      .mutateAsync({
        runId: selectedRunId,
        activeModifierIds: normalizedActiveModifierIds,
      })
      .then((data) => {
        if (cancelled) return;
        const parsed = asScenarioComparison(data.comparison);
        if (!parsed) return;
        const parsedKey = sortedUniqueIds(parsed.active_modifier_ids).join("|");
        if (parsedKey !== activeModifierKey) return;
        setComparison(parsed);
        setPendingModifierKey(null);
        setModifiersInitialized(true);
      })
      .catch(() => {
        if (!cancelled) {
          setComparison(null);
          setPendingModifierKey(null);
        }
      });

    return () => {
      cancelled = true;
    };
    // compareScenario mutation instance is stable in practice; we key requests by run + modifier key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModifierKey, normalizedActiveModifierIds, selectedRunId, selectedRunStatus]);

  useEffect(() => {
    if (activeModifierKey.length > 0) return;
    setComparison((current) => {
      if (!current) return current;
      return current.active_modifier_ids.length > 0 ? null : current;
    });
    setPendingModifierKey(null);
  }, [activeModifierKey]);

  const comparisonKey = useMemo(
    () => (comparison ? sortedUniqueIds(comparison.active_modifier_ids).join("|") : ""),
    [comparison],
  );
  const matchingComparison =
    activeModifierKey.length > 0 && comparisonKey === activeModifierKey ? comparison : null;
  const isModifierScenarioLoading =
    modifiersInitialized &&
    activeModifierKey.length > 0 &&
    (compareScenario.isPending || pendingModifierKey === activeModifierKey || !matchingComparison);
  const isValueUpdating = isModifierScenarioLoading || recalculateRun.isPending;

  const effectiveComparison =
    activeModifierKey.length > 0 ? matchingComparison : baseScenarioComparison;
  const effectiveStage2 = effectiveComparison?.stage2 ?? baselineStage2;
  const effectiveUnified = effectiveComparison?.unified_index ?? baselineUnified;
  const effectiveConfidence = effectiveComparison?.confidence ?? baselineConfidence;

  const statusText = useMemo(() => {
    if (selectedRun?.status === "RUNNING") return "running baseline simulation...";
    if (recalculateRun.isPending)
      return "recalculating with new freeform info… previous outputs remain visible until finished.";
    if (isModifierScenarioLoading) return "applying modifiers...";
    if (recalculateRun.isError) return recalculateRun.error.message;
    if (runsQuery.isError) return runsQuery.error.message;
    return "";
  }, [
    isModifierScenarioLoading,
    recalculateRun.error,
    recalculateRun.isError,
    recalculateRun.isPending,
    runsQuery.error,
    runsQuery.isError,
    selectedRun?.status,
  ]);

  const errors = asArray(selectedRun?.errors)
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .map((error) => `${asString(error.code, "ERROR")}: ${asString(error.message, "Unknown error")}`);

  const warnings = asArray(selectedRun?.warnings)
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .map((warning) => `${asString(warning.code, "WARNING")}: ${asString(warning.message)}`)
    .slice(0, 8);

  return (
    <>
      <section className="app-panel app-panel-padded">
        <div className="flex items-center justify-between gap-3">
          <h2 className="inline-flex items-center gap-2 text-base font-semibold">
            Add New Information
            <InfoTooltip
              title="How Updates Work"
              triggerLabel="How this works"
              body="You can paste new medical or lifestyle details here in plain language. The app pulls out key values, merges them into your profile, and reruns your forecast."
              bullets={[
                "Your current results stay visible while the update runs.",
                "Finished results automatically replace the previous values.",
              ]}
            />
          </h2>
          {selectedRun ? (
            <span className="text-xs text-white/65">Editing run: {selectedRun.id}</span>
          ) : (
            <span className="text-xs text-white/65">No run selected</span>
          )}
        </div>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedRun) return;
            const text = updateFreeform.trim();
            if (!text) return;
            recalculateRun.mutate({
              runId: selectedRun.id,
              freeformText: text,
              nutritionFreeform: updateNutrition.trim() || null,
            });
          }}
        >
          <textarea
            value={updateFreeform}
            onChange={(event) => setUpdateFreeform(event.target.value)}
            placeholder="Example: New labs from this week: LDL 118, SBP 124. I now exercise 220 minutes/week and sleep 7.2h."
            className="ui-textarea min-h-28 text-sm"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!selectedRun || recalculateRun.isPending || updateFreeform.trim().length === 0}
              className="ui-btn ui-btn-primary"
            >
              {recalculateRun.isPending ? "Recalculating..." : "Parse + Recalculate"}
            </button>
          </div>
        </form>
        {statusText ? <p className="app-status-message">{statusText}</p> : null}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <UnifiedIndexCard unifiedIndex={effectiveUnified} isUpdating={isValueUpdating} />
        <ConfidenceCard
          confidence={effectiveConfidence}
          modelAucs={STAGE2_AUC_BY_DISEASE}
          isUpdating={isValueUpdating}
        />
      </section>

      <RiskCharts
        baseline={baselineStage2}
        modified={effectiveStage2}
        isUpdating={isValueUpdating}
      />

      <ModifiersPanel
        modifiers={modifiers}
        modifierImpacts={modifierImpacts}
        activeModifierIds={normalizedActiveModifierIds}
        selectedCategory={modifierCategory}
        onCategoryChange={setModifierCategory}
        isApplying={isValueUpdating}
        onToggle={(modifierId) => {
          setActiveModifierIds((current) => {
            const next = current.includes(modifierId)
              ? current.filter((id) => id !== modifierId)
              : [...current, modifierId];
            const normalized = sortedUniqueIds(next);
            const previousNormalized = sortedUniqueIds(current);
            return sameStringArray(previousNormalized, normalized) ? current : normalized;
          });
        }}
      />

      <section className="app-panel app-panel-padded">
        <h2 className="text-base font-semibold">Runs</h2>
        <div className="mt-3 grid gap-2 text-xs">
          {(runsQuery.data ?? []).map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => {
                setActiveRunId(run.id);
                setComparison(null);
                setPendingModifierKey(null);
              }}
              className="app-list-row w-full text-left"
            >
              <span>{run.id}</span>
              <span>{run.status}</span>
            </button>
          ))}
        </div>
      </section>

      {warnings.length > 0 ? (
        <section className="app-alert app-alert-warning">
          <h2 className="text-sm font-semibold">Warnings</h2>
          <ul className="mt-2 grid gap-1">
            {warnings.map((warning, idx) => (
              <li key={`${warning}-${idx}`}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {errors.length > 0 ? (
        <section className="app-alert app-alert-error">
          <h2 className="text-sm font-semibold">Errors</h2>
          <ul className="mt-2 grid gap-1">
            {errors.map((error, idx) => (
              <li key={`${error}-${idx}`}>{error}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
