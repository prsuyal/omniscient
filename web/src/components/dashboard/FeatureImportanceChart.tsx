import type { FeatureImpact } from "~/types/medical";

interface FeatureImportanceChartProps {
  features: FeatureImpact[];
}

export function FeatureImportanceChart({ features }: FeatureImportanceChartProps) {
  if (features.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/25 bg-black/20 p-4 text-sm text-neutral-100/70">
        No feature-attribution data is available for this stream.
      </div>
    );
  }

  const maxMagnitude = Math.max(...features.map((feature) => Math.abs(feature.impact)), 0.001);

  return (
    <article className="rounded-2xl border border-white/12 bg-black/20 p-4">
      <p className="text-xs uppercase tracking-[0.14em] text-neutral-100/70">Feature importance</p>
      <ul className="mt-3 space-y-3">
        {features.map((feature) => {
          const widthPercent = (Math.abs(feature.impact) / maxMagnitude) * 100;
          const positive = feature.impact >= 0;

          return (
            <li key={feature.feature}>
              <div className="mb-1 flex items-center justify-between text-xs text-white/80">
                <span>{feature.feature}</span>
                <span>{feature.impact > 0 ? "+" : ""}{feature.impact.toFixed(2)}</span>
              </div>

              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full ${positive ? "bg-[#F18A4C]" : "bg-[#57EBC0]"}`}
                  style={{ width: `${widthPercent}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
