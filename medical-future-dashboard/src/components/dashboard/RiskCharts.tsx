"use client";

import { useMemo, useState } from "react";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { InfoTooltip } from "~/components/ui/InfoTooltip";

type Stage2Output = {
  diseases: string[];
  years: Array<{
    age: number;
    deterministic: Record<string, number>;
    uncertainty: Record<string, { mean: number; median: number; p05: number; p95: number }>;
  }>;
};

type Stage1MetricSummary = {
  meanWasserstein: number;
  meanRmse: number;
  variancePassRate: number;
} | null;

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function RiskCharts({
  baseline,
  modified,
  confidence,
  isUpdating = false,
  stage1MetricSummary,
  modelAucs,
}: {
  baseline: Stage2Output | null | undefined;
  modified: Stage2Output | null | undefined;
  confidence?: unknown;
  isUpdating?: boolean;
  stage1MetricSummary?: Stage1MetricSummary;
  modelAucs?: Record<string, number>;
}) {
  const diseases = useMemo(() => {
    const baselineDiseases = baseline?.diseases ?? [];
    const modifiedDiseases = modified?.diseases ?? [];
    if (baselineDiseases.length > 0) return baselineDiseases;
    return modifiedDiseases;
  }, [baseline?.diseases, modified?.diseases]);

  const [selectedDisease, setSelectedDisease] = useState<string | null>(diseases[0] ?? null);

  const activeDisease =
    selectedDisease && diseases.includes(selectedDisease) ? selectedDisease : diseases[0] ?? null;

  const chartData = useMemo(() => {
    if (!activeDisease || !baseline) return [];

    const modifiedByAge = new Map((modified?.years ?? []).map((year) => [year.age, year]));

    return baseline.years.map((year) => {
      const modifiedYear = modifiedByAge.get(year.age);
      return {
        age: year.age,
        baseline: clamp01(year.deterministic[activeDisease] ?? 0),
        modified: clamp01(modifiedYear?.deterministic[activeDisease] ?? year.deterministic[activeDisease] ?? 0),
      };
    });
  }, [activeDisease, baseline, modified?.years]);

  if (!baseline || diseases.length === 0) {
    return (
      <section className="rounded-2xl border border-white/20 bg-black/20 p-4">
        <h2 className="text-base font-semibold text-white">Risks Over Time</h2>
      </section>
    );
  }

  const lastPoint = chartData[chartData.length - 1];
  const horizonDelta = lastPoint ? (lastPoint.baseline ?? 0) - (lastPoint.modified ?? 0) : 0;

  return (
    <section className="rounded-2xl border border-white/20 bg-black/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 text-base font-semibold text-white">
          Cumulative Risks Over Time
          <InfoTooltip
            title="Risk Method (Cumulative By Age)"
            body="Risk at each age is cumulative event probability by that age. Curves are monotonic and represent 'event happened on/before this age' probability."
            bullets={[
              "Cumulative transform: p_t = 1 - (1 - p_{t-1})*(1 - annual_p_t)",
              ...Object.entries(modelAucs ?? {})
                .slice(0, 6)
                .map(([disease, auc]) => `${disease} model AUC: ${auc.toFixed(2)}`),
              stage1MetricSummary
                ? `Stage 1 mean metrics: Wasserstein ${stage1MetricSummary.meanWasserstein.toFixed(2)}, RMSE ${stage1MetricSummary.meanRmse.toFixed(2)}, variance-pass ${(stage1MetricSummary.variancePassRate * 100).toFixed(1)}%`
                : "Stage 1 metric summary unavailable",
            ]}
          />
          {isUpdating ? (
            <span className="rounded-full border border-amber-300/40 bg-amber-500/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-100">
              Updating
            </span>
          ) : null}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {diseases.map((disease) => (
            <button
              key={disease}
              type="button"
              onClick={() => setSelectedDisease(disease)}
              className={`rounded border px-2 py-1 text-xs ${
                activeDisease === disease
                  ? "border-cyan-300 bg-cyan-400/20 text-cyan-100"
                  : "border-white/25 text-white/80"
              }`}
            >
              {disease}
            </button>
          ))}
        </div>
      </div>

      <div className="relative mt-4 h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 8 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
            <XAxis dataKey="age" tick={{ fill: "#D1D5DB", fontSize: 12 }} />
            <YAxis
              tickFormatter={(value) => `${Math.round(value * 100)}%`}
              tick={{ fill: "#D1D5DB", fontSize: 12 }}
              domain={[0, 1]}
            />
            <Tooltip
              formatter={(value) => {
                const numeric = typeof value === "number" ? value : Number(value ?? 0);
                return pct(Number.isFinite(numeric) ? numeric : 0);
              }}
              contentStyle={{
                backgroundColor: "#111827",
                border: "1px solid rgba(255,255,255,0.2)",
              }}
            />
            <Legend />
            <Line
              type="linear"
              dataKey="baseline"
              name="Baseline"
              stroke="#fca5a5"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="modified"
              name="Modified"
              stroke="#34d399"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>

        {isUpdating ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg border border-white/15 bg-black/50 backdrop-blur-[1px]">
            <div className="rounded-lg border border-amber-300/40 bg-black/70 px-3 py-2 text-xs text-amber-100">
              Updating scenario… current curves remain from the last completed calculation.
            </div>
          </div>
        ) : null}
      </div>

      {chartData.length > 0 ? (
        <div className="mt-2 inline-flex items-center gap-1 text-xs text-white/70">
          Horizon delta ({activeDisease ?? "selected condition"}):{" "}
          {pct(horizonDelta)}
          <InfoTooltip
            title="Horizon Delta"
            body="Difference between baseline and modified cumulative risk at the final modeled age."
          />
        </div>
      ) : null}
    </section>
  );
}
