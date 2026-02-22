"use client";

import { useMemo } from "react";

import {
  AGE_MAX,
  AGE_MIN,
  AGE_RANGE,
  interventionInteractions,
  interventions,
  riskForecasts,
} from "~/data/mockMedicalData";
import {
  applyInterventionEffects,
  computeUnifiedIndex,
  findConflicts,
  formatRiskValue,
  getEvidenceWeight,
  interpolateByAge,
  normalizeRiskValue,
} from "~/lib/simulation";
import type {
  Intervention,
  InterventionImpactScore,
  PreventableRiskInsight,
  RiskCategory,
  RiskSnapshot,
  SeriesPoint,
} from "~/types/medical";

const ageToIndex = (age: number) => Math.max(0, Math.min(AGE_MAX - AGE_MIN, age - AGE_MIN));

export const useMedicalSimulation = ({
  selectedAge,
  activeInterventionIds,
}: {
  selectedAge: number;
  activeInterventionIds: string[];
}) => {
  return useMemo(() => {
    const activeInterventionSet = new Set(activeInterventionIds);
    const activeInterventions = interventions.filter((intervention) =>
      activeInterventionSet.has(intervention.id),
    );

    const conflictWarnings = findConflicts(activeInterventionIds, interventionInteractions);

    const riskSeries = riskForecasts.reduce<Record<RiskCategory, SeriesPoint[]>>((acc, risk) => {
      const series = AGE_RANGE.map((age) => {
        const baseline = interpolateByAge(risk.baselineByAge, age);
        const modified = applyInterventionEffects({
          category: risk.id,
          age,
          baseline,
          activeInterventions,
          conflicts: conflictWarnings,
        });

        return {
          age,
          baseline,
          modified,
          normalizedBaseline: normalizeRiskValue(risk.id, baseline),
          normalizedModified: normalizeRiskValue(risk.id, modified),
        };
      });

      acc[risk.id] = series;
      return acc;
    }, {} as Record<RiskCategory, SeriesPoint[]>);

    const selectedSnapshots = Object.fromEntries(
      riskForecasts.map((risk) => {
        const selectedPoint = riskSeries[risk.id][ageToIndex(selectedAge)]!;

        return [
          risk.id,
          {
            baseline: selectedPoint.baseline,
            modified: selectedPoint.modified,
            delta: selectedPoint.modified - selectedPoint.baseline,
            normalizedBaseline: selectedPoint.normalizedBaseline,
            normalizedModified: selectedPoint.normalizedModified,
          } satisfies RiskSnapshot,
        ];
      }),
    ) as Record<RiskCategory, RiskSnapshot>;

    const unifiedSeries = AGE_RANGE.map((age) => {
      const normalizedBaselineByCategory = Object.fromEntries(
        riskForecasts.map((risk) => {
          const point = riskSeries[risk.id][ageToIndex(age)]!;
          return [risk.id, point.normalizedBaseline];
        }),
      ) as Record<RiskCategory, number>;

      const normalizedModifiedByCategory = Object.fromEntries(
        riskForecasts.map((risk) => {
          const point = riskSeries[risk.id][ageToIndex(age)]!;
          return [risk.id, point.normalizedModified];
        }),
      ) as Record<RiskCategory, number>;

      return {
        age,
        baseline: computeUnifiedIndex({
          normalizedRiskByCategory: normalizedBaselineByCategory,
          activeInterventions: [],
          conflicts: [],
          age,
        }),
        modified: computeUnifiedIndex({
          normalizedRiskByCategory: normalizedModifiedByCategory,
          activeInterventions,
          conflicts: conflictWarnings,
          age,
        }),
      };
    });

    const selectedUnified = unifiedSeries[ageToIndex(selectedAge)]!;

    const topPreventableRisks = riskForecasts
      .map((risk) => {
        const snapshot = selectedSnapshots[risk.id];
        return {
          category: risk.id,
          label: risk.shortLabel,
          preventedAmount: snapshot.baseline - snapshot.modified,
          preventedNormalized: snapshot.normalizedBaseline - snapshot.normalizedModified,
          unit: risk.unit,
        } satisfies PreventableRiskInsight;
      })
      .filter((insight) => insight.preventedNormalized > 0)
      .sort((a, b) => b.preventedNormalized - a.preventedNormalized)
      .slice(0, 3);

    const fallbackPreventable =
      topPreventableRisks.length > 0
        ? topPreventableRisks
        : riskForecasts
            .map((risk) => {
              const snapshot = selectedSnapshots[risk.id];
              return {
                category: risk.id,
                label: risk.shortLabel,
                preventedAmount: snapshot.baseline - snapshot.modified,
                preventedNormalized: snapshot.normalizedBaseline,
                unit: risk.unit,
              } satisfies PreventableRiskInsight;
            })
            .sort((a, b) => b.preventedNormalized - a.preventedNormalized)
            .slice(0, 3);

    const scoreIntervention = (candidate: Intervention) => {
      const withCandidateIds = [...activeInterventionIds, candidate.id];
      const withCandidateSet = new Set(withCandidateIds);
      const withCandidateInterventions = interventions.filter((intervention) =>
        withCandidateSet.has(intervention.id),
      );
      const withCandidateConflicts = findConflicts(withCandidateIds, interventionInteractions);

      const normalizedImprovement = riskForecasts.reduce((sum, risk) => {
        const baseline = interpolateByAge(risk.baselineByAge, selectedAge);
        const candidateValue = applyInterventionEffects({
          category: risk.id,
          age: selectedAge,
          baseline,
          activeInterventions: withCandidateInterventions,
          conflicts: withCandidateConflicts,
        });

        const currentNormalized = selectedSnapshots[risk.id].normalizedModified;
        const candidateNormalized = normalizeRiskValue(risk.id, candidateValue);

        return sum + (currentNormalized - candidateNormalized);
      }, 0);

      const candidateUnified = computeUnifiedIndex({
        normalizedRiskByCategory: Object.fromEntries(
          riskForecasts.map((risk) => {
            const baseline = interpolateByAge(risk.baselineByAge, selectedAge);
            const candidateValue = applyInterventionEffects({
              category: risk.id,
              age: selectedAge,
              baseline,
              activeInterventions: withCandidateInterventions,
              conflicts: withCandidateConflicts,
            });
            return [risk.id, normalizeRiskValue(risk.id, candidateValue)];
          }),
        ) as Record<RiskCategory, number>,
        activeInterventions: withCandidateInterventions,
        conflicts: withCandidateConflicts,
        age: selectedAge,
      });

      const unifiedDelta = candidateUnified - selectedUnified.modified;

      const incompatibilityPenalty = (candidate.incompatibleWith ?? []).some((id) =>
        activeInterventionSet.has(id),
      )
        ? 8
        : 0;

      const score =
        normalizedImprovement +
        unifiedDelta * 1.8 +
        getEvidenceWeight(candidate.evidence) * 4 -
        incompatibilityPenalty;

      return {
        interventionId: candidate.id,
        title: candidate.title,
        category: candidate.category,
        evidence: candidate.evidence,
        score,
      } satisfies InterventionImpactScore;
    };

    const strongestInterventions = interventions
      .filter((intervention) => !activeInterventionSet.has(intervention.id))
      .map((candidate) => scoreIntervention(candidate))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const incompatibleWarnings = activeInterventions.flatMap((intervention) => {
      const conflicts = (intervention.incompatibleWith ?? []).filter((otherId) =>
        activeInterventionSet.has(otherId),
      );

      return conflicts.map(
        (otherId) =>
          `${intervention.title} has limited compatibility with ${interventions.find((item) => item.id === otherId)?.title ?? otherId}.`,
      );
    });

    const uniqueIncompatibilities = Array.from(new Set(incompatibleWarnings));

    const selectedAgeSummary = riskForecasts.map((risk) => {
      const snapshot = selectedSnapshots[risk.id];
      return `${risk.shortLabel}: ${formatRiskValue(snapshot.modified, risk.id)}`;
    });

    return {
      activeInterventions,
      riskSeries,
      selectedSnapshots,
      conflictWarnings,
      unifiedSeries,
      selectedUnified,
      topPreventableRisks: fallbackPreventable,
      strongestInterventions,
      incompatibleWarnings: uniqueIncompatibilities,
      selectedAgeSummary,
    };
  }, [activeInterventionIds, selectedAge]);
};
