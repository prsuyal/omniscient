"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { OptionAForm, type OptionAFormPayload } from "~/components/OptionAForm";
import {
  OptionBFreeform,
  type OptionBPayload,
} from "~/components/OptionBFreeform";
import { trpc } from "~/trpc/react";

type Tab = "optionA" | "optionB";

const INTERACTIVE_MONTE_CARLO_SAMPLES = 120;

export function DataInputWorkspace() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("optionA");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const createRun = trpc.simulation.createRun.useMutation({
    onSuccess(data) {
      setActiveRunId(data.id);
      router.push(`/dashboard?run=${data.id}`);
    },
  });

  const runsQuery = trpc.simulation.listRuns.useQuery(undefined, {
    refetchInterval: 5000,
  });

  const statusText = useMemo(() => {
    if (createRun.isPending) return "Running baseline simulation...";
    if (createRun.isError) return createRun.error.message;
    if (runsQuery.isError) return runsQuery.error.message;
    if (activeRunId) return `Created run ${activeRunId}. Redirecting to dashboard...`;
    return "";
  }, [
    activeRunId,
    createRun.error,
    createRun.isError,
    createRun.isPending,
    runsQuery.error,
    runsQuery.isError,
  ]);

  return (
    <>
      <section className="app-panel app-panel-padded">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <h2 className="app-section-title">Start A New Forecast Run</h2>
            <p className="app-section-copy">
              Submit structured or freeform health data. Baseline simulation runs
              first, then modifier scenarios warm in the background.
            </p>
          </div>

          <Link href="/dashboard" className="ui-btn ui-btn-subtle">
            Open Dashboard
          </Link>
        </div>
      </section>

      <section className="app-panel app-panel-padded">
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setTab("optionA")}
            className={
              tab === "optionA"
                ? "ui-segment ui-segment-active"
                : "ui-segment"
            }
          >
            Option A: Structured
          </button>
          <button
            type="button"
            onClick={() => setTab("optionB")}
            className={
              tab === "optionB"
                ? "ui-segment ui-segment-active"
                : "ui-segment"
            }
          >
            Option B: Freeform + PDF
          </button>
        </div>

        {tab === "optionA" ? (
          <OptionAForm
            isSubmitting={createRun.isPending}
            onSubmit={(payload: OptionAFormPayload) => {
              createRun.mutate({
                mode: "optionA",
                payload,
                monteCarloSamples: INTERACTIVE_MONTE_CARLO_SAMPLES,
              });
            }}
          />
        ) : (
          <OptionBFreeform
            isSubmitting={createRun.isPending}
            onSubmit={(payload: OptionBPayload) => {
              createRun.mutate({
                mode: "optionB",
                payload,
                monteCarloSamples: INTERACTIVE_MONTE_CARLO_SAMPLES,
              });
            }}
          />
        )}

        {statusText ? <p className="app-status-message mt-3">{statusText}</p> : null}
      </section>

      <section className="app-panel app-panel-padded">
        <h2 className="app-section-title">Recent Runs</h2>
        <div className="mt-3 grid gap-2 text-xs">
          {(runsQuery.data ?? []).map((run) => (
            <Link
              key={run.id}
              href={`/dashboard?run=${run.id}`}
              className="app-list-row"
            >
              <span>{run.id}</span>
              <span>{run.status}</span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
