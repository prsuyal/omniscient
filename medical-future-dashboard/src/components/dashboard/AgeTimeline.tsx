import { AGE_ANCHORS, AGE_MAX, AGE_MIN } from "~/data/mockMedicalData";

interface AgeTimelineProps {
  selectedAge: number;
  onAgeChange: (age: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  prefersReducedMotion: boolean;
}

export function AgeTimeline({
  selectedAge,
  onAgeChange,
  isPlaying,
  onTogglePlay,
  prefersReducedMotion,
}: AgeTimelineProps) {
  return (
    <section className="dashboard-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Age Timeline Simulation</h2>
          <p className="text-sm text-neutral-100/70">Drag or scrub across ages to recalculate projected outcomes.</p>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-full border border-white/20 px-3 py-1 text-sm text-white">Age {selectedAge}</span>
          <button
            className="rounded-full border border-white/30 px-3 py-1 text-sm text-white transition hover:border-white/60 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={prefersReducedMotion}
            onClick={onTogglePlay}
            type="button"
          >
            {prefersReducedMotion ? "Autoplay Disabled" : isPlaying ? "Pause" : "Autoplay"}
          </button>
        </div>
      </div>

      <div className="mt-5">
        <input
          aria-label="Select projected age"
          className="timeline-slider w-full"
          max={AGE_MAX}
          min={AGE_MIN}
          onChange={(event) => onAgeChange(Number(event.target.value))}
          step={1}
          type="range"
          value={selectedAge}
        />

        <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
          {AGE_ANCHORS.map((age) => (
            <button
              aria-current={selectedAge === age}
              className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                selectedAge === age
                  ? "border-[#57EBC0] bg-[#57EBC0]/15 text-white"
                  : "border-white/20 text-white/80 hover:border-white/40 hover:bg-white/10"
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
