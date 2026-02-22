import { AGE_ANCHORS } from "~/data/mockMedicalData";
import { formatRiskValue } from "~/lib/simulation";
import type { RiskCategory, SeriesPoint } from "~/types/medical";

interface RiskTrendChartProps {
  category: RiskCategory;
  series: SeriesPoint[];
  selectedAge: number;
}

const CHART_WIDTH = 620;
const CHART_HEIGHT = 260;
const PADDING = { top: 18, right: 16, bottom: 42, left: 54 };

export function RiskTrendChart({ category, series, selectedAge }: RiskTrendChartProps) {
  const selectedPoint =
    series.find((point) => point.age === selectedAge) ?? series.at(Math.floor(series.length / 2));

  if (!selectedPoint) {
    return (
      <div className="rounded-2xl border border-dashed border-white/25 bg-black/20 p-4 text-sm text-neutral-100/70">
        Projection data is unavailable for this risk stream.
      </div>
    );
  }

  const minValue = category === "healthcareCost" ? 0 : 0;
  const maxRaw = Math.max(
    ...series.map((point) => Math.max(point.baseline, point.modified)),
    category === "healthcareCost" ? 12000 : 100,
  );
  const maxValue =
    category === "healthcareCost" ? Math.ceil(maxRaw / 2000) * 2000 : Math.min(100, Math.ceil(maxRaw / 10) * 10);

  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const xForAge = (age: number) => {
    const firstAge = series[0]!.age;
    const lastAge = series[series.length - 1]!.age;
    const t = (age - firstAge) / (lastAge - firstAge);
    return PADDING.left + t * plotWidth;
  };

  const yForValue = (value: number) => {
    const t = (value - minValue) / (maxValue - minValue || 1);
    return PADDING.top + plotHeight - t * plotHeight;
  };

  const toPath = (selector: (point: SeriesPoint) => number) =>
    series
      .map((point, index) => {
        const x = xForAge(point.age);
        const y = yForValue(selector(point));
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");

  const baselinePath = toPath((point) => point.baseline);
  const modifiedPath = toPath((point) => point.modified);

  return (
    <div className="rounded-2xl border border-white/12 bg-black/20 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.14em] text-neutral-100/70">Risk trajectory</p>
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-2 text-white/80">
            <span className="h-2.5 w-2.5 rounded-full bg-[#f3dcb1]" /> Baseline
          </span>
          <span className="inline-flex items-center gap-2 text-white/80">
            <span className="h-2.5 w-2.5 rounded-full bg-[#57EBC0]" /> Modified
          </span>
        </div>
      </div>

      <svg
        aria-label="Baseline and modified risk over time"
        className="w-full"
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((step) => {
          const value = minValue + (maxValue - minValue) * step;
          const y = yForValue(value);
          return (
            <g key={`grid-${step}`}>
              <line
                stroke="rgba(255,255,255,0.14)"
                strokeDasharray="4 6"
                x1={PADDING.left}
                x2={CHART_WIDTH - PADDING.right}
                y1={y}
                y2={y}
              />
              <text
                fill="rgba(255,255,255,0.72)"
                fontSize="10"
                textAnchor="end"
                x={PADDING.left - 8}
                y={y + 3}
              >
                {category === "healthcareCost"
                  ? `$${Math.round(value / 1000)}k`
                  : `${Math.round(value)}%`}
              </text>
            </g>
          );
        })}

        {AGE_ANCHORS.map((age) => {
          const x = xForAge(age);
          return (
            <g key={`x-${age}`}>
              <line
                stroke="rgba(255,255,255,0.08)"
                x1={x}
                x2={x}
                y1={PADDING.top}
                y2={CHART_HEIGHT - PADDING.bottom}
              />
              <text
                fill="rgba(255,255,255,0.65)"
                fontSize="10"
                textAnchor="middle"
                x={x}
                y={CHART_HEIGHT - PADDING.bottom + 16}
              >
                {age}
              </text>
            </g>
          );
        })}

        <path
          d={baselinePath}
          fill="none"
          stroke="#f3dcb1"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.4"
        />
        <path
          d={modifiedPath}
          fill="none"
          stroke="#57EBC0"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.6"
        />

        <line
          stroke="rgba(255,255,255,0.4)"
          strokeDasharray="3 5"
          x1={xForAge(selectedAge)}
          x2={xForAge(selectedAge)}
          y1={PADDING.top}
          y2={CHART_HEIGHT - PADDING.bottom}
        />

        <circle cx={xForAge(selectedAge)} cy={yForValue(selectedPoint.baseline)} fill="#f3dcb1" r="4" />
        <circle cx={xForAge(selectedAge)} cy={yForValue(selectedPoint.modified)} fill="#57EBC0" r="4.2" />
      </svg>

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <p className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-white/80">
          Baseline @ {selectedAge}: {formatRiskValue(selectedPoint.baseline, category)}
        </p>
        <p className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-white/80">
          Modified @ {selectedAge}: {formatRiskValue(selectedPoint.modified, category)}
        </p>
      </div>
    </div>
  );
}
