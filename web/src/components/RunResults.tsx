"use client";

import { useMemo } from "react";
import { formatDiseaseLabel } from "~/lib/diseaseLabels";

type DiseaseRiskSummary = {
  age: number;
  deterministic: Record<string, number>;
};

type Stage2Output = {
  diseases?: string[];
  years?: Array<{
    age: number;
    deterministic: Record<string, number>;
    uncertainty?: Record<
      string,
      {
        mean: number;
        median: number;
        p05: number;
        p95: number;
      }
    >;
  }>;
};

type SimulationRunView = {
  id: string;
  status: string;
  createdAt: string | Date;
  rawSubmission?: unknown;
  canonicalInput?: unknown;
  stage1Output?: unknown;
  stage2Output?: unknown;
  warnings?: unknown;
  errors?: unknown;
};

const formatPct = (value: number | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
};

const asStage2 = (value: unknown): Stage2Output => {
  if (!value || typeof value !== "object") return {};
  return value as Stage2Output;
};

const asErrorList = (value: unknown): Array<{ code?: string; message?: string }> => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { code?: string; message?: string } => typeof item === "object" && item !== null);
};

const closestYear = (years: DiseaseRiskSummary[], targetAge: number): DiseaseRiskSummary | null => {
  if (!years.length) return null;
  let best = years[0]!;
  for (const year of years) {
    if (Math.abs(year.age - targetAge) < Math.abs(best.age - targetAge)) {
      best = year;
    }
  }
  return best;
};

export function RunResults({ run }: { run: SimulationRunView | null }) {
  const stage2 = asStage2(run?.stage2Output);
  const years = (stage2.years ?? []).map((year) => ({
    age: year.age,
    deterministic: year.deterministic ?? {},
  }));

  const selectedRows = useMemo(() => {
    if (!years.length) return [];
    const baseAge = years[0]!.age;
    const targets = [baseAge, baseAge + 10, baseAge + 20];

    return targets
      .map((targetAge) => closestYear(years, targetAge))
      .filter((row): row is DiseaseRiskSummary => !!row);
  }, [years]);

  const diseaseList = useMemo(() => {
    const configured = stage2.diseases ?? [];
    if (configured.length) return configured;
    return Object.keys(years[0]?.deterministic ?? {});
  }, [stage2.diseases, years]);

  const jsonHref = useMemo(() => {
    if (!run) return null;
    const jsonText = JSON.stringify(run, null, 2);
    return `data:application/json;charset=utf-8,${encodeURIComponent(jsonText)}`;
  }, [run]);

  if (!run) {
    return <p className="text-sm text-white/70">Run a simulation to view results.</p>;
  }

  const errors = asErrorList(run.errors);

  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-3 text-xs text-white/80">
        <span>
          <strong>ID:</strong> {run.id}
        </span>
        <span>
          <strong>Status:</strong> {run.status}
        </span>
        <span>
          <strong>Created:</strong> {new Date(run.createdAt).toLocaleString()}
        </span>
      </div>

      {errors.length ? (
        <div className="rounded border border-red-400/40 bg-red-950/40 p-3 text-red-100">
          {errors.map((error, idx) => (
            <p key={`${error.code ?? "error"}-${idx}`}>
              {error.code ? `${error.code}: ` : ""}
              {error.message ?? "Unknown error"}
            </p>
          ))}
        </div>
      ) : null}

      {selectedRows.length ? (
        <div className="overflow-x-auto rounded border border-white/20">
          <table className="min-w-full border-collapse text-xs">
            <thead>
              <tr className="bg-white/10 text-left">
                <th className="px-2 py-2">Age</th>
                {diseaseList.map((disease) => (
                  <th key={disease} className="px-2 py-2">
                    {formatDiseaseLabel(disease)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {selectedRows.map((row, idx) => (
                <tr key={`${row.age}-${idx}`} className="border-t border-white/15">
                  <td className="px-2 py-2">{row.age}</td>
                  {diseaseList.map((disease) => (
                    <td key={`${row.age}-${idx}-${disease}`} className="px-2 py-2">
                      {formatPct(row.deterministic[disease])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-white/70">No risk forecast rows are available yet.</p>
      )}

      {jsonHref ? (
        <a
          href={jsonHref}
          download={`simulation-${run.id}.json`}
          className="w-fit rounded border border-white/25 px-3 py-1 text-xs hover:bg-white/10"
        >
          Download Full Results JSON
        </a>
      ) : null}
    </div>
  );
}
