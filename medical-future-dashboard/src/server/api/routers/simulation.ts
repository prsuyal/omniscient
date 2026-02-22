import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  buildModifierImpact,
  startModifierWarmupInBackground,
} from "~/server/simulation/modifierWarmup";
import {
  applyFreeformUpdateToCanonical,
  runSimulationPipeline,
  SimulationPipelineError,
} from "~/server/simulation/pipeline";
import { generateCandidateModifiers } from "~/server/simulation/modifiers";
import {
  buildBaselineComparison,
  runScenarioWithCaching,
  runScenarioComparisonWithCaching,
} from "~/server/simulation/scenarioRunner";
import {
  canonicalUserInputSchema,
  confidenceOutputSchema,
  type ModifierDefinition,
  scenarioComparisonSchema,
  simulationCreateInputSchema,
  stage1OutputSchema,
  stage2OutputSchema,
  unifiedIndexOutputSchema,
} from "~/server/simulation/schemas";

const safeStringify = (value: unknown): string => JSON.stringify(value ?? null);

const safeParse = <T = unknown>(value: string | null | undefined): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const asIdString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
};

const serializeError = (error: unknown) => {
  if (error instanceof SimulationPipelineError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: "UNHANDLED_ERROR",
      message: error.message,
    };
  }

  return {
    code: "UNHANDLED_ERROR",
    message: String(error),
  };
};

const toClientRun = (run: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  inputMode: string;
  status: string;
  rawSubmission: string;
  canonicalInput: string | null;
  stage1Output: string | null;
  stage2Output: string | null;
  unifiedHealthIndex: string | null;
  confidenceScores: string | null;
  modifiers: string | null;
  modifierImpacts: string | null;
  baseScenarioComparison: string | null;
  scenarioComparisons: string | null;
  nutritionParsed: string | null;
  nutritionSourceMap: string | null;
  warnings: string | null;
  errors: string | null;
}) => {
  return {
    ...run,
    rawSubmission: safeParse(run.rawSubmission),
    canonicalInput: safeParse(run.canonicalInput),
    stage1Output: safeParse(run.stage1Output),
    stage2Output: safeParse(run.stage2Output),
    unifiedHealthIndex: safeParse(run.unifiedHealthIndex),
    confidenceScores: safeParse(run.confidenceScores),
    modifiers: safeParse(run.modifiers),
    modifierImpacts: safeParse(run.modifierImpacts),
    baseScenarioComparison: safeParse(run.baseScenarioComparison),
    scenarioComparisons: safeParse(run.scenarioComparisons),
    nutritionParsed: safeParse(run.nutritionParsed),
    nutritionSourceMap: safeParse(run.nutritionSourceMap),
    warnings: safeParse(run.warnings),
    errors: safeParse(run.errors),
  };
};

const parseScenarioConfigFromSubmission = (rawSubmissionText: string | null | undefined) => {
  const payload = safeParse<{ startAge?: number | null; endAge?: number | null; monteCarloSamples?: number }>(
    rawSubmissionText,
  );

  return {
    startAge: payload?.startAge ?? null,
    endAge: payload?.endAge ?? null,
    monteCarloSamples: payload?.monteCarloSamples ?? 120,
  };
};

export const simulationRouter = createTRPCRouter({
  createRun: protectedProcedure
    .input(simulationCreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      const run = await ctx.db.simulationRun.create({
        data: {
          userId: ctx.userId,
          inputMode: input.mode,
          status: "RUNNING",
          rawSubmission: safeStringify(input),
          warnings: safeStringify([]),
          errors: safeStringify([]),
          scenarioComparisons: safeStringify({}),
        },
      });

      try {
        const result = await runSimulationPipeline(input);

        const updated = await ctx.db.simulationRun.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED",
            canonicalInput: safeStringify(result.canonicalInput),
            stage1Output: safeStringify(result.stage1),
            stage2Output: safeStringify(result.stage2),
            unifiedHealthIndex: safeStringify(result.unifiedIndex),
            confidenceScores: safeStringify(result.confidence),
            modifiers: safeStringify(result.modifiers),
            modifierImpacts: safeStringify(result.modifierImpacts),
            baseScenarioComparison: safeStringify(result.baseScenarioComparison),
            scenarioComparisons: safeStringify(result.scenarioComparisons),
            nutritionParsed: safeStringify(result.canonicalInput.nutrition),
            nutritionSourceMap: safeStringify(result.canonicalInput.nutrition_source_map),
            warnings: safeStringify(result.warnings),
            errors: safeStringify(result.errors),
          },
        });

        startModifierWarmupInBackground({
          db: ctx.db,
          runId: updated.id,
          baseline: {
            canonicalInput: result.canonicalInput,
            stage1: result.stage1,
            stage2: result.stage2,
            unifiedIndex: result.unifiedIndex,
            confidence: result.confidence,
            cacheKey: `baseline-${updated.id}`,
          },
          modifiers: result.modifiers,
          config: {
            startAge: result.stage1.startAge,
            endAge: result.stage1.endAge,
            monteCarloSamples: input.monteCarloSamples,
          },
        });

        return {
          id: updated.id,
          status: updated.status,
          createdAt: updated.createdAt,
        };
      } catch (error) {
        await ctx.db.simulationRun.update({
          where: { id: run.id },
          data: {
            status: "FAILED",
            errors: safeStringify([serializeError(error)]),
          },
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Simulation pipeline failed.",
          cause: error,
        });
      }
    }),

  getRun: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const run = await ctx.db.simulationRun.findFirst({
        where: {
          id: input.id,
          userId: ctx.userId,
        },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      return toClientRun(run);
    }),

  latestRun: protectedProcedure.query(async ({ ctx }) => {
    const run = await ctx.db.simulationRun.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        userId: ctx.userId,
        status: "COMPLETED",
      },
    });

    return run ? toClientRun(run) : null;
  }),

  listRuns: protectedProcedure.query(async ({ ctx }) => {
    const runs = await ctx.db.simulationRun.findMany({
      orderBy: { createdAt: "desc" },
      where: {
        userId: ctx.userId,
      },
      take: 30,
    });
    return runs.map(toClientRun);
  }),

  compareScenario: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        activeModifierIds: z.array(z.string()).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const run = await ctx.db.simulationRun.findFirst({
        where: {
          id: input.runId,
          userId: ctx.userId,
        },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }

      if (run.status !== "COMPLETED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Run is not completed yet.",
        });
      }

      const canonicalInput = safeParse(run.canonicalInput);
      const stage1 = safeParse(run.stage1Output);
      const stage2 = safeParse(run.stage2Output);
      const unified = safeParse(run.unifiedHealthIndex);
      const confidence = safeParse(run.confidenceScores);
      const modifiers = safeParse<ModifierDefinition[]>(run.modifiers) ?? [];
      const storedComparisons = safeParse<Record<string, unknown>>(run.scenarioComparisons) ?? {};
      const normalizedModifierIds = [...new Set(input.activeModifierIds)].sort();

      if (!canonicalInput || !stage1 || !stage2 || !unified || !confidence) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Run payload is incomplete. Please rerun simulation.",
        });
      }

      const canonical = canonicalUserInputSchema.parse(canonicalInput);
      const stage1Parsed = stage1OutputSchema.parse(stage1);
      const stage2Parsed = stage2OutputSchema.parse(stage2);
      const unifiedParsed = unifiedIndexOutputSchema.parse(unified);
      const confidenceParsed = confidenceOutputSchema.parse(confidence);

      const key = normalizedModifierIds.join("+") || "baseline";
      const cachedComparisonRaw = storedComparisons[key];

      if (cachedComparisonRaw) {
        const parsedComparison = scenarioComparisonSchema.parse(cachedComparisonRaw);

        if (normalizedModifierIds.length === 1) {
          const modifier = modifiers.find((row) => row.id === normalizedModifierIds[0]);
          if (modifier) {
            const latestRun = await ctx.db.simulationRun.findFirst({
              where: {
                id: run.id,
                userId: ctx.userId,
              },
              select: {
                modifierImpacts: true,
              },
            });

            const existingImpacts = safeParse<Array<Record<string, unknown>>>(latestRun?.modifierImpacts) ?? [];
            const byId = new Map(
              existingImpacts
                .map((impact) => [asIdString(impact.modifier_id), impact] as const)
                .filter(([id]) => id.length > 0),
            );
            byId.set(modifier.id, buildModifierImpact(modifier, parsedComparison));

            await ctx.db.simulationRun.update({
              where: { id: run.id },
              data: {
                modifierImpacts: safeStringify([...byId.values()]),
              },
            });
          }
        }

        return {
          comparison: parsedComparison,
          fromCache: true,
        };
      }

      const baselineScenario = {
        canonicalInput: canonical,
        stage1: stage1Parsed,
        stage2: stage2Parsed,
        unifiedIndex: unifiedParsed,
        confidence: confidenceParsed,
        cacheKey: `baseline-${run.id}`,
      };

      const scenarioConfigFromSubmission = parseScenarioConfigFromSubmission(run.rawSubmission);
      const scenarioConfig = {
        startAge: scenarioConfigFromSubmission.startAge ?? stage1Parsed.startAge,
        endAge: scenarioConfigFromSubmission.endAge ?? stage1Parsed.endAge,
        monteCarloSamples: scenarioConfigFromSubmission.monteCarloSamples,
      };

      const baselineComparison = buildBaselineComparison(baselineScenario);

      const comparison =
        normalizedModifierIds.length === 0
          ? baselineComparison
          : (
              await runScenarioComparisonWithCaching({
                canonicalInput: canonical,
                baseline: baselineScenario,
                activeModifierIds: normalizedModifierIds,
                modifiers,
                config: scenarioConfig,
              })
            ).comparison;

      const latestRun = await ctx.db.simulationRun.findFirst({
        where: {
          id: run.id,
          userId: ctx.userId,
        },
        select: {
          scenarioComparisons: true,
          modifierImpacts: true,
          status: true,
        },
      });

      if (latestRun?.status !== "COMPLETED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Run changed while computing scenario. Please retry.",
        });
      }

      const latestComparisons = safeParse<Record<string, unknown>>(latestRun.scenarioComparisons) ?? {};

      const nextComparisons = {
        ...latestComparisons,
        baseline: latestComparisons.baseline ?? baselineComparison,
        [key]: comparison,
      };

      const existingImpacts = safeParse<Array<Record<string, unknown>>>(latestRun.modifierImpacts) ?? [];
      let nextImpacts = existingImpacts;

      if (normalizedModifierIds.length === 1) {
        const modifier = modifiers.find((row) => row.id === normalizedModifierIds[0]);
        if (modifier) {
          const byId = new Map(
            existingImpacts
              .map((impact) => [asIdString(impact.modifier_id), impact] as const)
              .filter(([id]) => id.length > 0),
          );
          byId.set(modifier.id, buildModifierImpact(modifier, comparison));
          nextImpacts = [...byId.values()];
        }
      }

      await ctx.db.simulationRun.update({
        where: { id: run.id },
        data: {
          scenarioComparisons: safeStringify(nextComparisons),
          modifierImpacts: safeStringify(nextImpacts),
        },
      });

      return {
        comparison,
        fromCache: false,
      };
    }),

  recalculateFromFreeformUpdate: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        freeformText: z.string().min(1).max(20_000),
        nutritionFreeform: z.string().max(8_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const run = await ctx.db.simulationRun.findFirst({
        where: {
          id: input.runId,
          userId: ctx.userId,
        },
      });
      if (!run) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }

      if (run.status !== "COMPLETED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Run is not completed yet.",
        });
      }

      const canonicalInput = safeParse(run.canonicalInput);
      const stage1Raw = safeParse(run.stage1Output);
      if (!canonicalInput || !stage1Raw) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Run payload is incomplete. Please rerun simulation.",
        });
      }

      const baseCanonical = canonicalUserInputSchema.parse(canonicalInput);
      const previousStage1 = stage1OutputSchema.parse(stage1Raw);
      const scenarioConfigFromSubmission = parseScenarioConfigFromSubmission(run.rawSubmission);
      const scenarioConfig = {
        startAge: scenarioConfigFromSubmission.startAge ?? previousStage1.startAge,
        endAge: scenarioConfigFromSubmission.endAge ?? previousStage1.endAge,
        monteCarloSamples: scenarioConfigFromSubmission.monteCarloSamples,
      };

      const updateResult = await applyFreeformUpdateToCanonical(
        baseCanonical,
        input.freeformText,
        input.nutritionFreeform,
      );

      const modifiers = await generateCandidateModifiers(updateResult.canonicalInput);
      const baselineScenario = await runScenarioWithCaching({
        canonicalInput: updateResult.canonicalInput,
        activeModifierIds: [],
        modifiers,
        config: scenarioConfig,
      });

      const baseScenarioComparison = buildBaselineComparison(baselineScenario);
      const scenarioComparisons = {
        baseline: baseScenarioComparison,
      };

      const existingWarnings = safeParse<Array<Record<string, unknown>>>(run.warnings) ?? [];
      const mergedWarnings = [
        ...existingWarnings,
        ...updateResult.warnings,
      ].slice(-20);

      const updated = await ctx.db.simulationRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          canonicalInput: safeStringify(baselineScenario.canonicalInput),
          stage1Output: safeStringify(baselineScenario.stage1),
          stage2Output: safeStringify(baselineScenario.stage2),
          unifiedHealthIndex: safeStringify(baselineScenario.unifiedIndex),
          confidenceScores: safeStringify(baselineScenario.confidence),
          modifiers: safeStringify(modifiers),
          modifierImpacts: safeStringify([]),
          baseScenarioComparison: safeStringify(baseScenarioComparison),
          scenarioComparisons: safeStringify(scenarioComparisons),
          nutritionParsed: safeStringify(baselineScenario.canonicalInput.nutrition),
          nutritionSourceMap: safeStringify(baselineScenario.canonicalInput.nutrition_source_map),
          warnings: safeStringify(mergedWarnings),
          errors: safeStringify([]),
        },
      });

      startModifierWarmupInBackground({
        db: ctx.db,
        runId: updated.id,
        baseline: baselineScenario,
        modifiers,
        config: scenarioConfig,
      });

      return {
        id: updated.id,
        status: updated.status,
        updatedAt: updated.updatedAt,
      };
    }),
});
