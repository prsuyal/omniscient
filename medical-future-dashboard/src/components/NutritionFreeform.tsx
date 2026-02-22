"use client";

type NutritionFreeformProps = {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
};

export function NutritionFreeform({
  value,
  onChange,
  label = "Nutrition (freeform)",
  placeholder = "e.g. Mediterranean diet most days, 2 servings fruit daily, avoid sugary drinks",
}: NutritionFreeformProps) {
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="ui-textarea min-h-24"
        placeholder={placeholder}
      />
      <span className="text-xs text-white/65">This text is parsed server-side into structured nutrition features.</span>
    </label>
  );
}
