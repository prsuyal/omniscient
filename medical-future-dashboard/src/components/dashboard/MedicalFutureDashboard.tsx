"use client";

import { useEffect, useMemo, useState } from "react";

import { AGE_DEFAULT, AGE_MAX, AGE_MIN } from "~/data/mockMedicalData";
import { usePrefersReducedMotion } from "~/hooks/usePrefersReducedMotion";
import { useMedicalSimulation } from "~/hooks/useMedicalSimulation";
import type { InterventionCategory, RiskCategory } from "~/types/medical";

import { BodyHeatMap } from "./BodyHeatMap";
import { InterventionControlPanel } from "./InterventionControlPanel";
import { SummarySection } from "./SummarySection";

const defaultInterventions = ["anti-inflammatory-diet", "strength-balance"];

export function MedicalFutureDashboard() {
  const [selectedAge, setSelectedAge] = useState(AGE_DEFAULT);
  const [selectedRisk, setSelectedRisk] = useState<RiskCategory | null>("cardiovascular");
  const [activeInterventionIds, setActiveInterventionIds] = useState<string[]>(defaultInterventions);
  const [categoryFilter, setCategoryFilter] = useState<InterventionCategory | "all">("all");
  const [isPlaying, setIsPlaying] = useState(false);

  const prefersReducedMotion = usePrefersReducedMotion();

  const simulation = useMedicalSimulation({
    selectedAge,
    activeInterventionIds,
  });

  useEffect(() => {
    if (!isPlaying || prefersReducedMotion) return;
    const timer = window.setInterval(() => {
      setSelectedAge((age) => (age >= AGE_MAX ? AGE_MIN : age + 1));
    }, 900);
    return () => window.clearInterval(timer);
  }, [isPlaying, prefersReducedMotion]);

  const conflictLabels = useMemo(
    () => [
      ...simulation.conflictWarnings.map((w) => w.label),
      ...simulation.incompatibleWarnings,
    ],
    [simulation.conflictWarnings, simulation.incompatibleWarnings],
  );

  const handleToggleIntervention = (interventionId: string) => {
    setActiveInterventionIds((current) =>
      current.includes(interventionId)
        ? current.filter((id) => id !== interventionId)
        : [...current, interventionId],
    );
  };

  const summaryLiveText = simulation.selectedAgeSummary.join(". ");

  return (
    <main className="relative min-h-screen overflow-hidden px-4 pb-16 pt-8 text-white sm:px-7 lg:px-10">
      <div className="mx-auto max-w-[1500px] space-y-6">

        {/* Header */}
        <header className="dashboard-panel relative overflow-hidden p-6">
          <div className="absolute -left-16 top-0 h-48 w-48 rounded-full bg-[radial-gradient(circle,rgba(87,235,192,0.35)_0%,transparent_72%)] blur-xl" />
          <div className="absolute -right-20 bottom-0 h-52 w-52 rounded-full bg-[radial-gradient(circle,rgba(241,138,76,0.3)_0%,transparent_74%)] blur-xl" />
          <p className="text-xs uppercase tracking-[0.24em] text-neutral-100/70">
            Medical Future Dashboard
          </p>
          <h1 className="mt-3 max-w-4xl text-3xl leading-tight text-white sm:text-4xl">
            Long-horizon risk forecasting with intervention simulation and real-time physiologic mapping.
          </h1>
          <p className="mt-3 max-w-3xl text-sm text-neutral-100/80">
            Baseline and modified futures are rendered side-by-side. The body explorer below is the
            primary interface — scrub the timeline and click any region to investigate organ-system
            projections across your lifespan.
          </p>
          <p aria-live="polite" className="sr-only">
            {summaryLiveText}
          </p>
        </header>

        {/* Summary strip */}
        <SummarySection
          selectedAge={selectedAge}
          strongestInterventions={simulation.strongestInterventions}
          topPreventableRisks={simulation.topPreventableRisks}
          unified={simulation.selectedUnified}
        />

        {/* ── HERO: Body Explorer ───────────────────────────────────────────── */}
        <BodyHeatMap
          activeInterventionIds={activeInterventionIds}
          isPlaying={isPlaying}
          onAgeChange={setSelectedAge}
          onSelectRisk={setSelectedRisk}
          onToggleIntervention={handleToggleIntervention}
          onTogglePlay={() => setIsPlaying((p) => !p)}
          prefersReducedMotion={prefersReducedMotion}
          riskSeries={simulation.riskSeries}
          selectedAge={selectedAge}
          selectedRisk={selectedRisk}
          snapshots={simulation.selectedSnapshots}
        />

        {/* ── Secondary: Intervention Control ──────────────────────────────── */}
        <InterventionControlPanel
          activeInterventionIds={activeInterventionIds}
          categoryFilter={categoryFilter}
          conflictLabels={conflictLabels}
          onCategoryFilterChange={setCategoryFilter}
          onToggleIntervention={handleToggleIntervention}
          selectedRisk={selectedRisk}
        />
      </div>
    </main>
  );
}
