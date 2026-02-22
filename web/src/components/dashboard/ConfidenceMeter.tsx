import { clamp } from "~/lib/simulation";

interface ConfidenceMeterProps {
  confidence: number;
}

const confidenceLabel = (confidence: number) => {
  if (confidence >= 0.82) {
    return "High confidence";
  }

  if (confidence >= 0.68) {
    return "Moderate confidence";
  }

  return "Lower confidence";
};

export function ConfidenceMeter({ confidence }: ConfidenceMeterProps) {
  const normalized = clamp(confidence, 0, 1);
  const degrees = normalized * 360;

  return (
    <article className="rounded-2xl border border-white/12 bg-black/20 p-4">
      <p className="text-xs uppercase tracking-[0.14em] text-neutral-100/70">Model confidence</p>

      <div className="mt-3 flex items-center gap-4">
        <div
          aria-label={`Model confidence ${Math.round(normalized * 100)} percent`}
          className="relative h-24 w-24 rounded-full"
          role="img"
          style={{
            background: `conic-gradient(#57EBC0 ${degrees}deg, rgba(255,255,255,0.12) 0deg)`,
          }}
        >
          <div className="absolute inset-[8px] rounded-full border border-white/20 bg-[#2A2727]" />
          <div className="absolute inset-0 flex items-center justify-center text-lg text-white">
            {Math.round(normalized * 100)}%
          </div>
        </div>

        <div>
          <p className="text-sm text-white">{confidenceLabel(normalized)}</p>
          <p className="mt-1 text-xs text-neutral-100/70">
            Reflects variance stability and out-of-sample calibration.
          </p>
        </div>
      </div>
    </article>
  );
}
