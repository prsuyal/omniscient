"use client";

import { BlockMath, InlineMath } from "react-katex";

const normalizeFormula = (formula: string): string => {
  const trimmed = formula.trim();
  if (trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length > 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export function InlineEquation({ formula, className = "" }: { formula: string; className?: string }) {
  const math = normalizeFormula(formula);
  return (
    <span className={className}>
      <InlineMath
        math={math}
        renderError={() => <span>{formula}</span>}
      />
    </span>
  );
}

export function BlockEquation({ formula, className = "" }: { formula: string; className?: string }) {
  const math = normalizeFormula(formula);
  return (
    <div className={className}>
      <BlockMath
        math={math}
        renderError={() => <span>{formula}</span>}
      />
    </div>
  );
}

