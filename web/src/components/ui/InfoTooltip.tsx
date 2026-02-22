"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { BlockEquation } from "~/components/ui/Equation";

type InfoTooltipProps = {
  title: string;
  body?: string;
  bullets?: string[];
  trigger?: "underline" | "icon";
  mode?: "tooltip" | "modal";
  interaction?: "hover" | "click";
  triggerLabel?: string;
  size?: "default" | "large";
  align?: "left" | "right";
  theme?: "neutral" | "emerald" | "cyan" | "amber" | "teal";
  children?: ReactNode;
  className?: string;
};

const MODAL_THEME_STYLES: Record<
  NonNullable<InfoTooltipProps["theme"]>,
  {
    panel: string;
    title: string;
    text: string;
    close: string;
  }
> = {
  neutral: {
    panel: "border-stone-300/35 bg-[#262322]/95",
    title: "text-stone-100",
    text: "text-stone-200/90",
    close: "border-stone-300/40 text-stone-100 hover:bg-stone-100/10",
  },
  emerald: {
    panel: "border-emerald-300/40 bg-[#102b26]/95",
    title: "text-emerald-100",
    text: "text-emerald-50/90",
    close: "border-emerald-300/40 text-emerald-100 hover:bg-emerald-200/10",
  },
  cyan: {
    panel: "border-cyan-300/40 bg-[#112d38]/95",
    title: "text-cyan-100",
    text: "text-cyan-50/90",
    close: "border-cyan-300/40 text-cyan-100 hover:bg-cyan-200/10",
  },
  amber: {
    panel: "border-amber-300/40 bg-[#382813]/95",
    title: "text-amber-100",
    text: "text-amber-50/90",
    close: "border-amber-300/40 text-amber-100 hover:bg-amber-200/10",
  },
  teal: {
    panel: "border-teal-300/40 bg-[#14312d]/95",
    title: "text-teal-100",
    text: "text-teal-50/90",
    close: "border-teal-300/40 text-teal-100 hover:bg-teal-200/10",
  },
};

const TOOLTIP_TEXT_CLASS = "text-[11px]";

const isFormula = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length > 2;
};

export function InfoTooltip({
  title,
  body,
  bullets = [],
  trigger = "underline",
  mode,
  interaction,
  triggerLabel,
  size = "default",
  align = "right",
  theme = "neutral",
  children,
  className = "",
}: InfoTooltipProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const resolvedMode = mode ?? (trigger === "icon" ? "modal" : "tooltip");
  const resolvedInteraction = interaction ?? (resolvedMode === "modal" ? "click" : "hover");
  const panelWidthClass = size === "large" ? "w-[min(42rem,calc(100vw-24px))]" : "w-[min(24rem,calc(100vw-24px))]";
  const panelPaddingClass = size === "large" ? "p-4" : "p-3";
  const panelTitleClass = `${TOOLTIP_TEXT_CLASS} font-semibold`;
  const panelTextClass = TOOLTIP_TEXT_CLASS;
  const resolvedLabel = triggerLabel ?? title;
  const modalTheme = useMemo(() => MODAL_THEME_STYLES[theme], [theme]);

  const recomputeTooltipPosition = useCallback(() => {
    if (resolvedMode !== "tooltip") return;
    if (!triggerRef.current || !panelRef.current || typeof window === "undefined") return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const panelRect = panelRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 12;
    const gap = 10;

    const desiredLeft =
      align === "left"
        ? triggerRect.left
        : align === "right"
          ? triggerRect.right - panelRect.width
          : triggerRect.left + triggerRect.width / 2 - panelRect.width / 2;

    const clampedLeft = Math.max(
      padding,
      Math.min(desiredLeft, viewportWidth - panelRect.width - padding),
    );

    let top = triggerRect.bottom + gap;
    if (top + panelRect.height + padding > viewportHeight) {
      const above = triggerRect.top - panelRect.height - gap;
      top = above >= padding ? above : Math.max(padding, viewportHeight - panelRect.height - padding);
    }

    setPosition({ left: clampedLeft, top });
  }, [align, resolvedMode]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen || resolvedMode !== "modal") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, resolvedMode]);

  useLayoutEffect(() => {
    if (!isOpen || resolvedMode !== "tooltip" || !isMounted) return;

    const frame = window.requestAnimationFrame(() => {
      recomputeTooltipPosition();
    });

    const onWindowChange = () => {
      recomputeTooltipPosition();
    };

    window.addEventListener("resize", onWindowChange);
    window.addEventListener("scroll", onWindowChange, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onWindowChange);
      window.removeEventListener("scroll", onWindowChange, true);
    };
  }, [isMounted, isOpen, recomputeTooltipPosition, resolvedMode]);

  const openHandlers =
    resolvedInteraction === "hover"
      ? {
          onMouseEnter: () => setIsOpen(true),
          onMouseLeave: () => setIsOpen(false),
          onFocus: () => setIsOpen(true),
          onBlur: () => setIsOpen(false),
        }
      : {
          onClick: () => setIsOpen((current) => !current),
        };

  const detailsContent = (
    <>
      {children ? (
        <div className={`mt-2 grid gap-2 ${panelTextClass} leading-relaxed`}>{children}</div>
      ) : (
        <>
          {body ? <p className={`mt-1 ${panelTextClass} leading-relaxed`}>{body}</p> : null}
          {bullets.length > 0 ? (
            <ul className={`mt-2 grid gap-1 ${panelTextClass}`}>
              {bullets.map((bullet, index) => (
                <li key={`${title}-${index}`} className="leading-relaxed">
                  {isFormula(bullet) ? (
                    <BlockEquation
                      formula={bullet}
                      className="my-1 [&_.katex]:text-inherit [&_.katex]:text-[0.92em]"
                    />
                  ) : (
                    <>• {bullet}</>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </>
  );

  return (
    <span className={`relative inline-flex ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`More info: ${title}`}
        aria-haspopup={resolvedMode === "modal" ? "dialog" : undefined}
        aria-expanded={resolvedInteraction === "click" ? isOpen : undefined}
        className={
          trigger === "icon"
            ? "inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border border-stone-300/60 bg-stone-900/40 text-[11px] font-semibold text-stone-100 transition hover:bg-stone-900/60"
            : "cursor-help border-b border-dotted border-stone-300/65 text-left text-inherit transition hover:border-emerald-200/70 hover:text-emerald-100"
        }
        {...openHandlers}
      >
        {trigger === "icon" ? "?" : resolvedLabel}
      </button>
      {isMounted && isOpen && resolvedMode === "tooltip"
        ? createPortal(
            <div
              ref={panelRef}
              role="tooltip"
              className={`fixed z-[72] ${panelWidthClass} ${panelPaddingClass} rounded-2xl border border-stone-300/60 bg-gradient-to-br from-[#f9f7f1] via-[#f3f0e7] to-[#ece7db] text-stone-700 shadow-2xl`}
              style={{
                left: position?.left ?? 12,
                top: position?.top ?? 12,
                visibility: position ? "visible" : "hidden",
              }}
            >
              <p className={`${panelTitleClass} text-stone-900`}>{title}</p>
              <div className="text-stone-700">{detailsContent}</div>
            </div>,
            document.body,
          )
        : null}
      {isMounted && isOpen && resolvedMode === "modal"
        ? createPortal(
            <div
              className="fixed inset-0 z-[90] flex items-center justify-center p-4"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setIsOpen(false);
              }}
            >
              <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
              <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className={`relative z-10 w-full max-w-3xl rounded-2xl border p-5 shadow-2xl ${modalTheme.panel} ${modalTheme.text}`}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <h3 className={`${TOOLTIP_TEXT_CLASS} font-semibold ${modalTheme.title}`}>{title}</h3>
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    className={`rounded-full border px-3 py-1 ${TOOLTIP_TEXT_CLASS} ${modalTheme.close}`}
                  >
                    Close
                  </button>
                </div>
                <div className={`grid gap-2 ${TOOLTIP_TEXT_CLASS} leading-relaxed ${modalTheme.text} [&_.katex]:text-inherit`}>
                  {detailsContent}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
