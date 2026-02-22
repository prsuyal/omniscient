import type { PrismaClient } from "@prisma/client";

import {
  buildBaselineComparison,
  runScenarioComparisonWithCaching,
  type ScenarioRunResult,
} from "~/server/simulation/scenarioRunner";
import {
  modifierImpactSchema,
  scenarioComparisonSchema,
  type ModifierDefinition,
  type ModifierImpact,
  type ScenarioComparison,
} from "~/server/simulation/schemas";
import { computeUnifiedHealthIndex } from "~/server/simulation/unifiedIndex";

type BackgroundWarmupArgs = {
  db: PrismaClient;
  runId: string;
  baseline: ScenarioRunResult;
  modifiers: ModifierDefinition[];
  config: {
    startAge: number;
    endAge: number;
    monteCarloSamples: number;
  };
};

const safeStringify = (value: unknown): string => JSON.stringify(value ?? null);

const safeParse = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const scenarioKeyForModifierIds = (ids: string[]): string => ids.slice().sort().join("+") || "baseline";

const toModifierImpact = (
  modifier: ModifierDefinition,
  comparison: ScenarioComparison,
): ModifierImpact => {
  return {
    modifier_id: modifier.id,
    category: modifier.category,
    title: modifier.title,
    stage2: comparison.stage2,
    unified_index: comparison.unified_index,
    confidence: comparison.confidence,
    risk_delta_by_disease_at_horizon: comparison.risk_delta_by_disease_at_horizon,
    unified_index_delta: comparison.unified_index_delta,
  };
};

const parseScenarioComparisons = (
  raw: string | null | undefined,
): Record<string, ScenarioComparison> => {
  const parsed = safeParse<Record<string, unknown>>(raw, {});
  const out: Record<string, ScenarioComparison> = {};

  for (const [key, value] of Object.entries(parsed)) {
    const result = scenarioComparisonSchema.safeParse(value);
    if (result.success) {
      out[key] = result.data;
    }
  }

  return out;
};

const parseModifierImpacts = (raw: string | null | undefined): ModifierImpact[] => {
  const parsed = safeParse<unknown[]>(raw, []);
  const out: ModifierImpact[] = [];

  for (const row of parsed) {
    const result = modifierImpactSchema.safeParse(row);
    if (result.success) {
      out.push(result.data);
    }
  }

  return out;
};

const buildBestAchievableStage2 = (
  baselineStage2: ScenarioRunResult["stage2"],
  comparisons: ScenarioComparison[],
): ScenarioRunResult["stage2"] => {
  const horizonIndex = baselineStage2.years.length - 1;
  const horizonYear = baselineStage2.years[horizonIndex];
  if (!horizonYear) return baselineStage2;

  const bestDeterministic: Record<string, number> = {
    ...horizonYear.deterministic,
  };

  for (const comparison of comparisons) {
    if (comparison.active_modifier_ids.length === 0) continue;
    const comparisonHorizon = comparison.stage2.years[comparison.stage2.years.length - 1];
    if (!comparisonHorizon) continue;

    for (const [disease, risk] of Object.entries(comparisonHorizon.deterministic)) {
      const currentBest = bestDeterministic[disease];
      if (currentBest == null) {
        bestDeterministic[disease] = risk;
        continue;
      }
      bestDeterministic[disease] = Math.min(currentBest, risk);
    }
  }

  return {
    ...baselineStage2,
    years: baselineStage2.years.map((year, idx) =>
      idx === horizonIndex
        ? {
            ...year,
            deterministic: bestDeterministic,
          }
        : year,
    ),
  };
};

const recomputeUnifiedIndex = (
  baseline: ScenarioRunResult,
  comparisonsByKey: Record<string, ScenarioComparison>,
) => {
  const comparisons = Object.values(comparisonsByKey);
  const bestAchievableStage2 = buildBestAchievableStage2(baseline.stage2, comparisons);

  return computeUnifiedHealthIndex({
    canonicalInput: baseline.canonicalInput,
    stage1: baseline.stage1,
    stage2: baseline.stage2,
    bestAchievableStage2,
  });
};

const persistWarmupProgress = async (input: {
  db: PrismaClient;
  runId: string;
  baseline: ScenarioRunResult;
  comparisonKey: string;
  comparison: ScenarioComparison;
  impact: ModifierImpact | null;
}) => {
  const latest = await input.db.simulationRun.findUnique({
    where: { id: input.runId },
    select: {
      id: true,
      status: true,
      scenarioComparisons: true,
      modifierImpacts: true,
    },
  });

  if (latest?.status !== "COMPLETED") {
    return;
  }

  const mergedComparisons = parseScenarioComparisons(latest.scenarioComparisons);
  mergedComparisons.baseline ??= buildBaselineComparison(input.baseline);
  mergedComparisons[input.comparisonKey] = input.comparison;

  const mergedImpacts = parseModifierImpacts(latest.modifierImpacts);
  if (input.impact) {
    const byId = new Map(mergedImpacts.map((impact) => [impact.modifier_id, impact]));
    byId.set(input.impact.modifier_id, input.impact);
    mergedImpacts.length = 0;
    mergedImpacts.push(...byId.values());
  }

  const unifiedIndex = recomputeUnifiedIndex(input.baseline, mergedComparisons);

  await input.db.simulationRun.update({
    where: { id: input.runId },
    data: {
      scenarioComparisons: safeStringify(mergedComparisons),
      modifierImpacts: safeStringify(mergedImpacts),
      unifiedHealthIndex: safeStringify(unifiedIndex),
    },
  });
};

const warmupInFlight = new Map<string, Promise<void>>();

const runModifierWarmup = async (input: BackgroundWarmupArgs): Promise<void> => {
  if (input.modifiers.length === 0) return;

  const baselineComparison = buildBaselineComparison(input.baseline);
  await persistWarmupProgress({
    db: input.db,
    runId: input.runId,
    baseline: input.baseline,
    comparisonKey: "baseline",
    comparison: baselineComparison,
    impact: null,
  });

  for (const modifier of input.modifiers) {
    const latest = await input.db.simulationRun.findUnique({
      where: { id: input.runId },
      select: {
        id: true,
        status: true,
        scenarioComparisons: true,
        modifierImpacts: true,
      },
    });

    if (latest?.status !== "COMPLETED") {
      return;
    }

    const key = scenarioKeyForModifierIds([modifier.id]);
    const existingComparisons = parseScenarioComparisons(latest.scenarioComparisons);
    const existingImpacts = parseModifierImpacts(latest.modifierImpacts);

    const alreadyHasComparison = !!existingComparisons[key];
    const alreadyHasImpact = existingImpacts.some((impact) => impact.modifier_id === modifier.id);
    if (alreadyHasComparison && alreadyHasImpact) {
      continue;
    }

    try {
      const result = await runScenarioComparisonWithCaching({
        canonicalInput: input.baseline.canonicalInput,
        baseline: input.baseline,
        activeModifierIds: [modifier.id],
        modifiers: input.modifiers,
        config: input.config,
      });

      await persistWarmupProgress({
        db: input.db,
        runId: input.runId,
        baseline: input.baseline,
        comparisonKey: key,
        comparison: result.comparison,
        impact: toModifierImpact(modifier, result.comparison),
      });
    } catch (error) {
      console.error(
        `[modifierWarmup] failed for run=${input.runId} modifier=${modifier.id}:`,
        error,
      );
    }
  }
};

export const startModifierWarmupInBackground = (input: BackgroundWarmupArgs): void => {
  if (input.modifiers.length === 0) return;
  if (warmupInFlight.has(input.runId)) return;

  const task = Promise.resolve()
    .then(async () => {
      await runModifierWarmup(input);
    })
    .catch((error) => {
      console.error(`[modifierWarmup] run=${input.runId} crashed:`, error);
    })
    .finally(() => {
      warmupInFlight.delete(input.runId);
    });

  warmupInFlight.set(input.runId, task);
};

export const buildModifierImpact = toModifierImpact;
