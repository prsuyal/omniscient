"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";

import { usePrefersReducedMotion } from "~/hooks/usePrefersReducedMotion";

const HERO_PROMPT = "What if you could see your future...";

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const lerp = (start: number, end: number, progress: number) =>
  start + (end - start) * progress;

export function LandingScrollExperience() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion) {
      setProgress(1);
      return;
    }

    let frame = 0;

    const updateProgress = () => {
      const viewportHeight = window.innerHeight || 1;
      const nextProgress = clamp(window.scrollY / (viewportHeight * 3.2), 0, 1);
      setProgress(nextProgress);
      frame = 0;
    };

    const onScroll = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(updateProgress);
    };

    updateProgress();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [prefersReducedMotion]);

  const computed = useMemo(() => {
    const imageProgress = clamp((progress - 0.24) / 0.38, 0, 1);
    const typedProgress = clamp((progress - 0.06) / 0.28, 0, 1);
    const typedBoost = clamp((progress - 0.3) / 0.22, 0, 1);
    const cutThroughProgress = clamp((progress - 0.48) / 0.16, 0, 1);
    const numbersProgress = clamp((progress - 0.58) / 0.16, 0, 1);
    const ctaProgress = clamp((progress - 0.74) / 0.2, 0, 1);
    const narrativeFadeOut = 1 - clamp((progress - 0.74) / 0.13, 0, 1);
    const cornerBrandFade = 1 - clamp((progress - 0.05) / 0.16, 0, 1);

    return {
      cornerBrandOpacity: cornerBrandFade,
      cornerBrandY: lerp(0, -8, 1 - cornerBrandFade),
      imageScale: lerp(1, 0.36, imageProgress),
      imageOpacity: lerp(1, 0.01, imageProgress),
      imageTranslateY: lerp(0, 360, imageProgress),
      typedScale: lerp(1, 1.32, typedBoost),
      typedOpacity: lerp(0.82, 1, typedProgress) * narrativeFadeOut,
      typedTranslateY: lerp(12, -4, typedBoost),
      typedText: HERO_PROMPT.slice(
        0,
        Math.floor(HERO_PROMPT.length * typedProgress),
      ),
      showCursor: progress > 0.008 && narrativeFadeOut > 0.15,
      cutThroughOpacity: cutThroughProgress * narrativeFadeOut,
      cutThroughScale: lerp(0.88, 1.16, cutThroughProgress),
      cutThroughY: lerp(30, 0, cutThroughProgress),
      numbersOpacity: numbersProgress * narrativeFadeOut,
      numbersScale: lerp(0.88, 1.08, numbersProgress),
      numbersY: lerp(30, 0, numbersProgress),
      ctaOpacity: ctaProgress,
      ctaScale: lerp(0.88, 1, ctaProgress),
      ctaY: lerp(48, 0, ctaProgress),
    };
  }, [progress]);

  return (
    <main className="landing-scroll-page">
      <div className="landing-noise-layer" aria-hidden="true" />

      <section className="landing-scroll-track" aria-label="Omniscient intro">
        <div className="landing-sticky-stage">
          <div className="landing-stage-content">
            <p
              className="landing-corner-brand"
              style={{
                opacity: computed.cornerBrandOpacity,
                transform: `translateY(${computed.cornerBrandY}px)`,
              }}
            >
              Omniscient
            </p>

            <div
              className="landing-image-shell"
              style={{
                opacity: computed.imageOpacity,
                transform: `translateY(${computed.imageTranslateY}px) scale(${computed.imageScale})`,
              }}
            >
              <Image
                src="/landing.svg"
                alt="Abstract human figure for Omniscient"
                width={940}
                height={940}
                priority
                className="landing-hero-image"
              />
            </div>

            <div className="landing-copy-shell">
              <p
                className="landing-typed-line"
                style={{
                  opacity: computed.typedOpacity,
                  transform: `translate(-50%, ${computed.typedTranslateY}px) scale(${computed.typedScale})`,
                }}
              >
                {computed.typedText}
                {computed.showCursor ? (
                  <span className="landing-cursor" aria-hidden="true">
                    |
                  </span>
                ) : null}
              </p>

              <p
                className="landing-message-line"
                style={{
                  opacity: computed.cutThroughOpacity,
                  transform: `translate(-50%, ${computed.cutThroughY}px) scale(${computed.cutThroughScale})`,
                }}
              >
                cut through the noise
              </p>

              <p
                className="landing-message-line landing-message-line-soft"
                style={{
                  opacity: computed.numbersOpacity,
                  transform: `translate(-50%, ${computed.numbersY}px) scale(${computed.numbersScale})`,
                }}
              >
                and see the numbers from your life
              </p>

              <div
                className="landing-cta-block"
                style={{
                  opacity: computed.ctaOpacity,
                  transform: `translate(-50%, -50%) translateY(${computed.ctaY}px) scale(${computed.ctaScale})`,
                }}
              >
                <p className="landing-brand">Omniscient</p>
                <div className="landing-actions">
                  <button
                    type="button"
                    className="landing-action landing-action-primary"
                    onClick={() => void signIn("google", { callbackUrl: "/app" })}
                  >
                    Get Started
                  </button>
                  <button
                    type="button"
                    className="landing-action landing-action-secondary"
                    onClick={() => void signIn("google", { callbackUrl: "/app" })}
                  >
                    Log In
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
