"use client";

import { useMemo, useState } from "react";

import {
  AGE_ANCHORS,
  AGE_MAX,
  AGE_MIN,
  RISK_ORDER,
  interventions,
  riskForecasts,
} from "~/data/mockMedicalData";
import {
  clamp,
  evidenceLabel,
  formatDeltaValue,
  formatRiskValue,
  hexToRgba,
  normalizedRiskToColor,
} from "~/lib/simulation";
import type { RiskCategory, RiskSnapshot, SeriesPoint } from "~/types/medical";

import { ConfidenceMeter } from "./ConfidenceMeter";
import { FeatureImportanceChart } from "./FeatureImportanceChart";
import { RiskTrendChart } from "./RiskTrendChart";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BodyHeatMapProps {
  selectedAge: number;
  onAgeChange: (age: number) => void;
  selectedRisk: RiskCategory | null;
  snapshots: Record<RiskCategory, RiskSnapshot>;
  riskSeries: Record<RiskCategory, SeriesPoint[]>;
  activeInterventionIds: string[];
  onSelectRisk: (risk: RiskCategory | null) => void;
  onToggleIntervention: (interventionId: string) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  prefersReducedMotion: boolean;
}

type ZoneShape =
  | { shape: "circle"; cx: number; cy: number; r: number }
  | { shape: "ellipse"; cx: number; cy: number; rx: number; ry: number };

interface BodyZone {
  risk: RiskCategory;
  areas: ZoneShape[];
  hotspot: { x: number; y: number };
  label: string;
  labelX: number;
  labelY: number;
  labelAlign: "left" | "right";
  pulseR: number;
}

interface ParticlePoint {
  id: string;
  x: number;
  y: number;
  seed: number;
}

interface ParticleLink {
  a: number;
  b: number;
  opacity: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEWBOX_WIDTH = 560;
const VIEWBOX_HEIGHT = 980;

// Defined bottom-to-top: later entries render on top in SVG hit-test order
const BODY_ZONES: BodyZone[] = [
  {
    risk: "mobility",
    hotspot: { x: 280, y: 860 },
    label: "Mobility",
    labelX: 406,
    labelY: 876,
    labelAlign: "right",
    pulseR: 54,
    areas: [
      { shape: "ellipse", cx: 244, cy: 858, rx: 30, ry: 82 },
      { shape: "ellipse", cx: 316, cy: 858, rx: 30, ry: 82 },
    ],
  },
  {
    risk: "healthcareCost",
    hotspot: { x: 280, y: 534 },
    label: "Health Cost",
    labelX: 420,
    labelY: 550,
    labelAlign: "right",
    pulseR: 68,
    areas: [{ shape: "ellipse", cx: 280, cy: 534, rx: 94, ry: 52 }],
  },
  {
    risk: "arthritis",
    hotspot: { x: 152, y: 452 },
    label: "Arthritis",
    labelX: 96,
    labelY: 458,
    labelAlign: "left",
    pulseR: 36,
    areas: [
      { shape: "circle", cx: 152, cy: 452, r: 38 },
      { shape: "circle", cx: 408, cy: 452, r: 38 },
      { shape: "circle", cx: 238, cy: 748, r: 34 },
      { shape: "circle", cx: 322, cy: 748, r: 34 },
    ],
  },
  {
    risk: "kidney",
    hotspot: { x: 244, y: 414 },
    label: "Kidney",
    labelX: 96,
    labelY: 420,
    labelAlign: "left",
    pulseR: 44,
    areas: [
      { shape: "ellipse", cx: 244, cy: 414, rx: 46, ry: 46 },
      { shape: "ellipse", cx: 316, cy: 414, rx: 46, ry: 46 },
    ],
  },
  {
    risk: "liver",
    hotspot: { x: 332, y: 390 },
    label: "Liver",
    labelX: 452,
    labelY: 404,
    labelAlign: "right",
    pulseR: 50,
    areas: [{ shape: "ellipse", cx: 332, cy: 390, rx: 56, ry: 50 }],
  },
  {
    risk: "cardiovascular",
    hotspot: { x: 262, y: 302 },
    label: "Cardiovascular",
    labelX: 424,
    labelY: 290,
    labelAlign: "right",
    pulseR: 72,
    areas: [{ shape: "ellipse", cx: 262, cy: 302, rx: 80, ry: 84 }],
  },
  {
    risk: "auditoryLoss",
    hotspot: { x: 226, y: 148 },
    label: "Auditory",
    labelX: 96,
    labelY: 154,
    labelAlign: "left",
    pulseR: 26,
    areas: [
      { shape: "circle", cx: 224, cy: 148, r: 28 },
      { shape: "circle", cx: 336, cy: 148, r: 28 },
    ],
  },
  {
    risk: "workingMemory",
    hotspot: { x: 280, y: 118 },
    label: "Cognition",
    labelX: 410,
    labelY: 108,
    labelAlign: "right",
    pulseR: 60,
    areas: [{ shape: "circle", cx: 280, cy: 118, r: 64 }],
  },
];

const fieldPresets: Array<{
  risk: RiskCategory;
  x: number;
  y: number;
  spread: number;
  weight: number;
}> = [
  { risk: "workingMemory", x: 280, y: 128, spread: 84, weight: 1.1 },
  { risk: "auditoryLoss", x: 232, y: 145, spread: 62, weight: 0.9 },
  { risk: "auditoryLoss", x: 328, y: 145, spread: 62, weight: 0.9 },
  { risk: "cardiovascular", x: 280, y: 314, spread: 120, weight: 1.25 },
  { risk: "liver", x: 336, y: 404, spread: 96, weight: 1.05 },
  { risk: "kidney", x: 246, y: 402, spread: 82, weight: 1 },
  { risk: "kidney", x: 316, y: 402, spread: 82, weight: 1 },
  { risk: "mobility", x: 280, y: 650, spread: 198, weight: 1.12 },
  { risk: "arthritis", x: 214, y: 284, spread: 64, weight: 0.9 },
  { risk: "arthritis", x: 168, y: 444, spread: 66, weight: 0.92 },
  { risk: "arthritis", x: 392, y: 444, spread: 66, weight: 0.92 },
  { risk: "arthritis", x: 236, y: 734, spread: 72, weight: 1.04 },
  { risk: "arthritis", x: 324, y: 734, spread: 72, weight: 1.04 },
  { risk: "healthcareCost", x: 340, y: 540, spread: 300, weight: 0.42 },
];

const emphasisByRisk: Record<RiskCategory, Array<{ x: number; y: number; spread: number }>> = {
  workingMemory: [{ x: 280, y: 128, spread: 94 }],
  auditoryLoss: [
    { x: 232, y: 145, spread: 72 },
    { x: 328, y: 145, spread: 72 },
  ],
  cardiovascular: [{ x: 280, y: 314, spread: 138 }],
  liver: [{ x: 336, y: 404, spread: 110 }],
  kidney: [
    { x: 246, y: 402, spread: 94 },
    { x: 316, y: 402, spread: 94 },
  ],
  mobility: [{ x: 280, y: 664, spread: 210 }],
  arthritis: [
    { x: 168, y: 444, spread: 82 },
    { x: 392, y: 444, spread: 82 },
    { x: 236, y: 734, spread: 90 },
    { x: 324, y: 734, spread: 90 },
  ],
  healthcareCost: [{ x: 340, y: 540, spread: 320 }],
};

// ─── Particle Geometry ────────────────────────────────────────────────────────

const fract = (v: number) => v - Math.floor(v);

const noise = (x: number, y: number, seed: number) =>
  fract(Math.sin(x * 127.1 + y * 311.7 + seed * 19.27) * 43758.5453123);

const inCircle = (x: number, y: number, cx: number, cy: number, r: number) =>
  (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2;

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  ((x - cx) ** 2) / rx ** 2 + ((y - cy) ** 2) / ry ** 2 <= 1;

const distanceToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) => {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const denom = abx * abx + aby * aby;
  const t = clamp(denom === 0 ? 0 : (apx * abx + apy * aby) / denom, 0, 1);
  return Math.hypot(px - ax - t * abx, py - ay - t * aby);
};

const isInsideSilhouette = (x: number, y: number) => {
  const head = inCircle(x, y, 280, 118, 58);
  const neck = x >= 252 && x <= 308 && y >= 166 && y <= 218;
  const shoulders = inEllipse(x, y, 280, 242, 146, 74);
  const torso = inEllipse(x, y, 280, 346, 116, 176);
  const pelvis = inEllipse(x, y, 280, 534, 98, 86);
  const leftUpperArm = distanceToSegment(x, y, 198, 270, 132, 448) <= 30;
  const leftForeArm = distanceToSegment(x, y, 132, 448, 124, 568) <= 22;
  const rightUpperArm = distanceToSegment(x, y, 362, 270, 428, 448) <= 30;
  const rightForeArm = distanceToSegment(x, y, 428, 448, 436, 568) <= 22;
  const leftUpperLeg = distanceToSegment(x, y, 252, 580, 236, 760) <= 34;
  const leftLowerLeg = distanceToSegment(x, y, 236, 760, 226, 930) <= 24;
  const rightUpperLeg = distanceToSegment(x, y, 308, 580, 324, 760) <= 34;
  const rightLowerLeg = distanceToSegment(x, y, 324, 760, 334, 930) <= 24;
  const leftFoot = inEllipse(x, y, 222, 948, 28, 16);
  const rightFoot = inEllipse(x, y, 338, 948, 28, 16);
  return (
    head || neck || shoulders || torso || pelvis ||
    leftUpperArm || leftForeArm || rightUpperArm || rightForeArm ||
    leftUpperLeg || leftLowerLeg || rightUpperLeg || rightLowerLeg ||
    leftFoot || rightFoot
  );
};

const generateParticlePoints = (): ParticlePoint[] => {
  const points: ParticlePoint[] = [];
  let index = 0;
  for (let y = 52; y <= 950; y += 10) {
    for (let x = 88; x <= 472; x += 10) {
      const jx = (noise(x, y, 1) - 0.5) * 4.2;
      const jy = (noise(x, y, 2) - 0.5) * 4.2;
      const px = x + jx;
      const py = y + jy;
      if (!isInsideSilhouette(px, py)) continue;
      const densityGate = noise(x, y, 9);
      const centralityPenalty = Math.abs(px - 280) / 260;
      if (densityGate < 0.18 + centralityPenalty * 0.18) continue;
      points.push({ id: `p-${index}`, x: px, y: py, seed: noise(x, y, 21) });
      index += 1;
    }
  }
  return points;
};

const buildParticleLinks = (points: ParticlePoint[]): ParticleLink[] => {
  const links: ParticleLink[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point) continue;
    let createdForPoint = 0;
    for (let j = i + 1; j < Math.min(points.length, i + 19); j += 1) {
      const peer = points[j];
      if (!peer) continue;
      const dx = peer.x - point.x;
      const dy = peer.y - point.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 16 || d2 > 280 || Math.abs(dy) > 24) continue;
      const keep = point.seed * 0.62 + peer.seed * 0.38;
      if (keep < 0.46) continue;
      links.push({ a: i, b: j, opacity: 0.1 + keep * 0.16 });
      createdForPoint += 1;
      if (createdForPoint >= 3) break;
    }
  }
  return links;
};

// ─── Zone Shape Renderer Helpers ──────────────────────────────────────────────

function renderZoneShape(
  area: ZoneShape,
  key: string,
  props: React.SVGProps<SVGCircleElement> & React.SVGProps<SVGEllipseElement>,
) {
  if (area.shape === "circle") {
    return <circle key={key} cx={area.cx} cy={area.cy} r={area.r} {...props} />;
  }
  return <ellipse key={key} cx={area.cx} cy={area.cy} rx={area.rx} ry={area.ry} {...props} />;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BodyHeatMap({
  selectedAge,
  onAgeChange,
  selectedRisk,
  snapshots,
  riskSeries,
  activeInterventionIds,
  onSelectRisk,
  onToggleIntervention,
  isPlaying,
  onTogglePlay,
  prefersReducedMotion,
}: BodyHeatMapProps) {
  const [hoveredZone, setHoveredZone] = useState<RiskCategory | null>(null);

  const particlePoints = useMemo(() => generateParticlePoints(), []);
  const particleLinks = useMemo(() => buildParticleLinks(particlePoints), [particlePoints]);

  const averageBaseline = useMemo(
    () => RISK_ORDER.reduce((s, r) => s + snapshots[r].normalizedBaseline, 0) / RISK_ORDER.length,
    [snapshots],
  );

  const averageModified = useMemo(
    () => RISK_ORDER.reduce((s, r) => s + snapshots[r].normalizedModified, 0) / RISK_ORDER.length,
    [snapshots],
  );

  const fieldSources = useMemo(
    () =>
      fieldPresets.map((p) => ({
        x: p.x,
        y: p.y,
        spread: p.spread,
        weight: p.weight,
        baseline: snapshots[p.risk].normalizedBaseline,
        modified: snapshots[p.risk].normalizedModified,
      })),
    [snapshots],
  );

  const selectedFocusAnchors = useMemo(
    () => (selectedRisk ? (emphasisByRisk[selectedRisk] ?? []) : []),
    [selectedRisk],
  );

  const pointStyles = useMemo(
    () =>
      particlePoints.map((point) => {
        let baseAcc = 0;
        let modAcc = 0;
        let totalW = 0;

        fieldSources.forEach((src) => {
          const dx = point.x - src.x;
          const dy = point.y - src.y;
          const inf = Math.exp(-(dx * dx + dy * dy) / (2 * src.spread * src.spread)) * src.weight;
          if (inf < 0.012) return;
          totalW += inf;
          baseAcc += inf * src.baseline;
          modAcc += inf * src.modified;
        });

        const jitter = (point.seed - 0.5) * 4.2;
        const baseVal = clamp(
          (totalW > 0 ? baseAcc / totalW : averageBaseline) + jitter * 0.45,
          0,
          100,
        );
        const modVal = clamp(
          (totalW > 0 ? modAcc / totalW : averageModified) + jitter * 0.6,
          0,
          100,
        );

        const focusStrength = selectedFocusAnchors.reduce((max, anchor) => {
          const dx = point.x - anchor.x;
          const dy = point.y - anchor.y;
          return Math.max(
            max,
            Math.exp(-(dx * dx + dy * dy) / (2 * anchor.spread * anchor.spread)),
          );
        }, 0);

        return {
          baselineColor: normalizedRiskToColor(baseVal),
          modifiedColor: normalizedRiskToColor(modVal),
          baselineOpacity: clamp(0.1 + baseVal / 260 + focusStrength * 0.14, 0.09, 0.56),
          modifiedOpacity: clamp(0.22 + modVal / 150 + focusStrength * 0.24, 0.16, 0.97),
          radius: clamp(0.8 + modVal / 78 + focusStrength * 0.62 + point.seed * 0.28, 0.72, 3.3),
          linkOpacityBoost: clamp(0.7 + focusStrength * 1.2, 0.65, 1.85),
        };
      }),
    [particlePoints, fieldSources, averageBaseline, averageModified, selectedFocusAnchors],
  );

  // Ambient glow shifts from teal → red as overall risk climbs
  const ambientGlowColor = normalizedRiskToColor(averageModified);

  // Top 3 highest-risk zones (excluding selected) get passive pulse rings
  const highRiskZoneIds = useMemo(
    () =>
      BODY_ZONES.filter(({ risk }) => snapshots[risk].normalizedModified > 42)
        .sort((a, b) => snapshots[b.risk].normalizedModified - snapshots[a.risk].normalizedModified)
        .slice(0, 3)
        .map(({ risk }) => risk),
    [snapshots],
  );

  // Detail panel data
  const selectedRiskMeta = selectedRisk
    ? riskForecasts.find((r) => r.id === selectedRisk)
    : null;
  const selectedSeries = selectedRisk ? (riskSeries[selectedRisk] ?? []) : [];
  const selectedSnapshot = selectedRisk ? snapshots[selectedRisk] : null;
  const relatedInterventions = selectedRisk
    ? interventions.filter((i) => (i.effects[selectedRisk] ?? 0) !== 0)
    : [];

  return (
    <section className="dashboard-panel">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-6 pb-5 pt-6">
        <div>
          <p className="text-[10px] uppercase tracking-[0.26em] text-neutral-100/55">
            Predictive Body Explorer
          </p>
          <h2 className="mt-1 text-2xl text-white">Physiologic Risk Map</h2>
          <p className="mt-1.5 max-w-lg text-sm text-neutral-100/60">
            Abstract particle silhouette — heat rises with projected risk as you scrub the timeline.
            Click any body region to open organ-system projections.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="rounded-full border border-white/22 px-4 py-1.5 text-sm font-semibold text-white">
            Age {selectedAge}
          </span>
          <button
            className="rounded-full border border-white/28 px-4 py-1.5 text-sm text-white/85 transition hover:border-[#57ebc0]/60 hover:bg-[#57ebc0]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-38"
            disabled={prefersReducedMotion}
            onClick={onTogglePlay}
            type="button"
          >
            {prefersReducedMotion ? "Autoplay off" : isPlaying ? "⏸ Pause" : "▶ Autoplay"}
          </button>
        </div>
      </div>

      {/* ── Main: Silhouette + Detail Panel ────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(0,390px)_1fr]">

        {/* ── Silhouette Column ───────────────────────────────────────────── */}
        <div className="particle-stage relative m-4 mr-2 rounded-[1.75rem] border border-white/10 bg-black/25 p-3">
          <svg
            aria-label="Interactive dotted human silhouette — click a region to explore health projections"
            className="mx-auto w-full"
            role="img"
            viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
          >
            <defs>
              <radialGradient id="body-ambient" cx="50%" cy="32%" r="68%">
                <stop offset="0%" stopColor={hexToRgba(ambientGlowColor, 0.22)} />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </radialGradient>
            </defs>

            {/* Ambient ambient glow — shifts color with overall risk */}
            <ellipse cx="280" cy="510" fill="url(#body-ambient)" rx="246" ry="440" />

            {/* ── Baseline particle layer (ghost) ── */}
            <g aria-hidden="true" transform="translate(-2,0)">
              {particleLinks.map((link, i) => {
                const a = particlePoints[link.a];
                const b = particlePoints[link.b];
                const s = pointStyles[link.a];
                if (!a || !b || !s) return null;
                return (
                  <line
                    key={`bl-${i}`}
                    stroke={hexToRgba(s.baselineColor, link.opacity * 0.65)}
                    strokeWidth="0.75"
                    x1={a.x} x2={b.x} y1={a.y} y2={b.y}
                  />
                );
              })}
              {particlePoints.map((pt, i) => {
                const s = pointStyles[i];
                if (!s) return null;
                return (
                  <circle
                    key={`bd-${pt.id}`}
                    cx={pt.x} cy={pt.y}
                    fill={hexToRgba(s.baselineColor, s.baselineOpacity)}
                    r={Math.max(0.68, s.radius - 0.48)}
                  />
                );
              })}
            </g>

            {/* ── Modified particle layer (vivid heat) ── */}
            <g aria-hidden="true">
              {particleLinks.map((link, i) => {
                const a = particlePoints[link.a];
                const b = particlePoints[link.b];
                const s = pointStyles[link.a];
                if (!a || !b || !s) return null;
                return (
                  <line
                    key={`ml-${i}`}
                    stroke={hexToRgba(s.modifiedColor, Math.min(0.46, link.opacity * s.linkOpacityBoost))}
                    strokeWidth="0.95"
                    x1={a.x} x2={b.x} y1={a.y} y2={b.y}
                  />
                );
              })}
              {particlePoints.map((pt, i) => {
                const s = pointStyles[i];
                if (!s) return null;
                return (
                  <circle
                    key={`md-${pt.id}`}
                    cx={pt.x} cy={pt.y}
                    fill={hexToRgba(s.modifiedColor, s.modifiedOpacity)}
                    r={s.radius}
                  />
                );
              })}
            </g>

            {/* ── Pulsing risk rings ── */}
            <g aria-hidden="true" className="pointer-events-none">
              {BODY_ZONES.map(({ risk, hotspot, pulseR }) => {
                const isSelected = selectedRisk === risk;
                const isHighRisk = highRiskZoneIds.includes(risk) && !isSelected;
                if (!isSelected && !isHighRisk) return null;
                const color = normalizedRiskToColor(snapshots[risk].normalizedModified);
                return (
                  <circle
                    key={`pulse-${risk}`}
                    className={isSelected ? "zone-pulse-selected" : "zone-pulse-risk"}
                    cx={hotspot.x}
                    cy={hotspot.y}
                    fill="none"
                    r={pulseR}
                    stroke={color}
                    strokeWidth={isSelected ? "2" : "1.2"}
                  />
                );
              })}
            </g>

            {/* ── Clickable body zones ── */}
            <g aria-label="Body region selectors">
              {BODY_ZONES.map((zone) => {
                const { risk, areas, hotspot, label, labelX, labelY, labelAlign } = zone;
                const isActive = selectedRisk === risk;
                const isHovered = hoveredZone === risk;
                const snapshot = snapshots[risk];
                const color = normalizedRiskToColor(snapshot.normalizedModified);
                const riskMeta = riskForecasts.find((r) => r.id === risk);

                return (
                  <g
                    key={`zone-${risk}`}
                    aria-label={`${riskMeta?.shortLabel ?? risk} — ${formatRiskValue(snapshot.modified, risk)} at age ${selectedAge}. Click to explore.`}
                    aria-pressed={isActive}
                    role="button"
                    style={{ cursor: "pointer" }}
                    onClick={() => onSelectRisk(isActive ? null : risk)}
                    onMouseEnter={() => setHoveredZone(risk)}
                    onMouseLeave={() => setHoveredZone(null)}
                  >
                    {/* Hover / active area glow */}
                    {(isHovered || isActive) &&
                      areas.map((area, i) =>
                        renderZoneShape(area, `glow-${risk}-${i}`, {
                          fill: hexToRgba(color, isActive ? 0.15 : 0.08),
                          ...(area.shape === "circle"
                            ? { r: area.r + 10 }
                            : { rx: area.rx + 10, ry: area.ry + 10 }),
                        }),
                      )}

                    {/* Transparent hit areas */}
                    {areas.map((area, i) =>
                      renderZoneShape(area, `hit-${risk}-${i}`, { fill: "transparent" }),
                    )}

                    {/* Active dashed border on primary area */}
                    {isActive &&
                      areas.slice(0, 1).map((area, i) =>
                        renderZoneShape(area, `ring-${risk}-${i}`, {
                          fill: "none",
                          stroke: color,
                          strokeWidth: "1.8",
                          strokeDasharray: "4 5",
                          opacity: "0.8",
                          ...(area.shape === "circle"
                            ? { r: area.r + 4 }
                            : { rx: area.rx + 4, ry: area.ry + 4 }),
                        }),
                      )}

                    {/* Callout line + label */}
                    <line
                      opacity={isActive || isHovered ? 0.92 : 0.34}
                      stroke={color}
                      strokeDasharray="3 5"
                      strokeWidth="1"
                      x1={hotspot.x}
                      x2={labelX}
                      y1={hotspot.y}
                      y2={labelY}
                    />
                    <text
                      fill={
                        isActive || isHovered
                          ? "rgba(255,255,255,0.96)"
                          : "rgba(255,255,255,0.52)"
                      }
                      fontSize="11.5"
                      textAnchor={labelAlign === "left" ? "end" : "start"}
                      x={labelX + (labelAlign === "left" ? -5 : 5)}
                      y={labelY + 4}
                    >
                      {label}
                    </text>

                    {/* Hotspot indicator dot */}
                    <circle
                      cx={hotspot.x}
                      cy={hotspot.y}
                      fill={hexToRgba(color, isActive || isHovered ? 0.95 : 0.6)}
                      r="5.5"
                      stroke={hexToRgba(color, 0.35)}
                      strokeWidth="1.8"
                    />
                  </g>
                );
              })}
            </g>
          </svg>

          {/* Heat key */}
          <div className="mt-3 px-2 pb-1">
            <div className="h-2 rounded-full bg-[linear-gradient(90deg,#57EBC0_0%,#A1F27F_26%,#F6CD62_52%,#F18A4C_76%,#D33552_100%)]" />
            <div className="mt-1.5 flex justify-between text-[10px] text-neutral-100/50">
              <span>Low projected risk</span>
              <span>High projected risk</span>
            </div>
            <p className="mt-1 text-[10px] text-neutral-100/40">
              Dim layer = baseline · Vivid layer = modified trajectory
            </p>
          </div>
        </div>

        {/* ── Detail Panel Column ─────────────────────────────────────────── */}
        <div className="flex flex-col p-4 pl-2 lg:max-h-[900px]">
          {selectedRisk && selectedRiskMeta && selectedSnapshot ? (
            <div className="flex h-full flex-col gap-4 overflow-y-auto rounded-[1.6rem] border border-white/12 bg-black/20 p-5">

              {/* Panel header */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-100/55">
                    {selectedRiskMeta.bodyLabel}
                  </p>
                  <h3 className="mt-0.5 text-xl font-semibold text-white">
                    {selectedRiskMeta.label}
                  </h3>
                  <div className="mt-2.5 flex items-center gap-3">
                    <span
                      className="rounded-full px-3.5 py-1 text-sm font-semibold text-black"
                      style={{
                        backgroundColor: normalizedRiskToColor(selectedSnapshot.normalizedModified),
                      }}
                    >
                      {formatRiskValue(selectedSnapshot.modified, selectedRisk)}
                    </span>
                    <span className="text-xs text-neutral-100/55">
                      Baseline: {formatRiskValue(selectedSnapshot.baseline, selectedRisk)}
                    </span>
                    {selectedSnapshot.delta !== 0 && (
                      <span
                        className={`text-xs ${
                          selectedSnapshot.delta <= 0 ? "text-[#57ebc0]" : "text-[#f18a4c]"
                        }`}
                      >
                        {selectedSnapshot.delta <= 0 ? "↓" : "↑"}{" "}
                        {Math.abs(selectedSnapshot.delta).toFixed(1)}
                        {selectedRisk === "healthcareCost" ? " USD" : " pts"} vs baseline
                      </span>
                    )}
                  </div>
                </div>
                <button
                  aria-label="Close detail panel"
                  className="shrink-0 rounded-full border border-white/20 px-3 py-1 text-xs text-white/65 transition hover:border-white/44 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  onClick={() => onSelectRisk(null)}
                  type="button"
                >
                  ✕ Close
                </button>
              </div>

              {/* Risk trajectory chart */}
              <RiskTrendChart
                category={selectedRisk}
                selectedAge={selectedAge}
                series={selectedSeries}
              />

              {/* Confidence + Explanation row */}
              <div className="grid gap-4 sm:grid-cols-2">
                <ConfidenceMeter confidence={selectedRiskMeta.confidence} />
                <article className="rounded-2xl border border-white/12 bg-black/20 p-4">
                  <p className="text-xs uppercase tracking-[0.14em] text-neutral-100/60">
                    Model explanation
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-neutral-100/80">
                    {selectedRiskMeta.explanation}
                  </p>
                </article>
              </div>

              {/* Feature importance */}
              <FeatureImportanceChart features={selectedRiskMeta.featureImportance} />

              {/* Targeted interventions */}
              <article className="rounded-2xl border border-white/12 bg-black/20 p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-neutral-100/60">
                  Targeted interventions — {selectedRiskMeta.shortLabel}
                </p>
                {relatedInterventions.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {relatedInterventions.map((intervention) => {
                      const isActive = activeInterventionIds.includes(intervention.id);
                      const riskDelta = intervention.effects[selectedRisk] ?? 0;
                      return (
                        <li
                          key={intervention.id}
                          className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/20 p-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm text-white">{intervention.title}</p>
                            <p className="text-xs text-neutral-100/55">
                              {evidenceLabel[intervention.evidence]}
                            </p>
                            <p
                              className={`mt-1 text-xs ${
                                riskDelta <= 0 ? "text-[#57ebc0]" : "text-[#f18a4c]"
                              }`}
                            >
                              {formatDeltaValue(riskDelta, selectedRisk)} projected on this risk
                            </p>
                          </div>
                          <button
                            aria-label={`${isActive ? "Disable" : "Enable"} ${intervention.title}`}
                            aria-pressed={isActive}
                            className={`shrink-0 rounded-full border px-3 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                              isActive
                                ? "border-[#57ebc0] bg-[#57ebc0]/20 text-white"
                                : "border-white/25 text-white/80 hover:border-white/50 hover:bg-white/10"
                            }`}
                            onClick={() => onToggleIntervention(intervention.id)}
                            type="button"
                          >
                            {isActive ? "Active" : "Activate"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-neutral-100/50">
                    No targeted interventions available for this risk stream.
                  </p>
                )}
              </article>
            </div>
          ) : (
            /* Empty state */
            <div className="flex h-full flex-col items-center justify-center gap-6 rounded-[1.6rem] border border-dashed border-white/14 bg-black/10 p-8 text-center">
              <div
                className="text-5xl opacity-30"
                style={{ color: normalizedRiskToColor(averageModified) }}
              >
                ◉
              </div>
              <div>
                <p className="text-base text-white/75">Select a body region</p>
                <p className="mt-2 text-sm text-neutral-100/50">
                  Click any highlighted zone on the silhouette to open organ-system projections,
                  model confidence, and targeted interventions.
                </p>
              </div>
              {/* Quick-select shortcuts */}
              <div className="flex flex-wrap justify-center gap-2">
                {BODY_ZONES.slice().reverse().slice(0, 5).map(({ risk, label }) => {
                  const snapshot = snapshots[risk];
                  const color = normalizedRiskToColor(snapshot.normalizedModified);
                  return (
                    <button
                      key={risk}
                      className="rounded-full border px-3.5 py-1.5 text-xs text-white/75 transition hover:bg-white/10"
                      style={{ borderColor: hexToRgba(color, 0.55) }}
                      onClick={() => onSelectRisk(risk)}
                      type="button"
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-neutral-100/38">
                Or scrub the timeline below to watch risk heat evolve across your lifespan
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Footer: Age Timeline ────────────────────────────────────────────── */}
      <div className="mt-2 border-t border-white/10 px-6 pb-6 pt-5">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-[0.22em] text-neutral-100/55">
            Age timeline — scrub to see risk heat evolve
          </p>
          <span className="text-[11px] text-neutral-100/40">
            {AGE_MIN} → {AGE_MAX}
          </span>
        </div>
        <input
          aria-label="Select projected age"
          className="timeline-slider w-full"
          max={AGE_MAX}
          min={AGE_MIN}
          onChange={(e) => onAgeChange(Number(e.target.value))}
          step={1}
          type="range"
          value={selectedAge}
        />
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {AGE_ANCHORS.map((age) => (
            <button
              aria-current={selectedAge === age}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                selectedAge === age
                  ? "border-[#57ebc0] bg-[#57ebc0]/15 text-white"
                  : "border-white/18 text-white/65 hover:border-white/36 hover:bg-white/8"
              }`}
              key={age}
              onClick={() => onAgeChange(age)}
              type="button"
            >
              {age}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
