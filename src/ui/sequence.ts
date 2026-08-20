import { useEffect, useState } from 'react';
import { presentation } from '../content/config';

/**
 * A reveal that is playing out, or one that has finished.
 *
 * The motion itself is CSS -- staggered `animation-delay`s off a `--step` custom
 * property -- because a JS-driven transform races React's render and stutters. What
 * React has to know is only *when the sequence is over*, for two reasons: numbers
 * have to land on their real values rather than an eased approximation of them, and
 * the whole thing has to be skippable.
 */
export interface RevealSequence {
  /** Seconds since the reveal began. Pinned at its full length once settled. */
  elapsed: number;
  /** True once every line has landed, the sequence was skipped, or motion is off. */
  settled: boolean;
}

/**
 * Runs a reveal of `seconds` and settles it on any key or pointer press.
 *
 * Under reduced motion it is settled on the first render and no frame loop is ever
 * started, which is the whole point: the setting is a save-file toggle as well as a
 * media query, so a CSS-only guard would leave the in-game switch doing nothing.
 */
export function useRevealSequence(reducedMotion: boolean, seconds: number): RevealSequence {
  const [state, setState] = useState<RevealSequence>(() => (reducedMotion ? { elapsed: seconds, settled: true } : { elapsed: 0, settled: false }));

  useEffect(() => {
    const done = { elapsed: seconds, settled: true };
    if (reducedMotion) {
      setState(done);
      return;
    }
    setState({ elapsed: 0, settled: false });
    let frame = 0;
    let floor = 0;
    const startedAt = performance.now();
    const settle = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      window.clearTimeout(floor);
      setState(done);
    };
    const tick = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      if (elapsed >= seconds) {
        settle();
        return;
      }
      setState({ elapsed, settled: false });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    /**
     * A floor under the frame loop, not a second driver of it. Browsers stop serving
     * animation frames to a hidden tab, so a player who alt-tabs while the results
     * are revealing comes back to a screen frozen on its first frame -- every line
     * still at zero opacity, every number still at zero. The timer only ever settles
     * the sequence, which is the same thing the last frame would have done.
     */
    floor = window.setTimeout(settle, seconds * 1000);
    // Any input ends it. A results screen that cannot be dismissed is one the player
    // learns to resent by the tenth run.
    window.addEventListener('keydown', settle);
    window.addEventListener('pointerdown', settle);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(floor);
      window.removeEventListener('keydown', settle);
      window.removeEventListener('pointerdown', settle);
    };
  }, [reducedMotion, seconds]);

  return state;
}

/** How long the results reveal runs for, from the first line to the last number. */
export function resultsSequenceSeconds(): number {
  return presentation.resultsSteps * presentation.resultsStaggerSeconds + presentation.resultsLineSeconds + presentation.resultsCountSeconds;
}

/** When the line at `step` starts moving, matching the CSS `--step` delay exactly. */
export function stepDelaySeconds(step: number): number {
  return step * presentation.resultsStaggerSeconds;
}

/**
 * A number on its way to `target`, held at zero until the line carrying it has
 * arrived. Pure, so the easing is testable without a frame loop, and exact at the
 * end: a settled sequence returns the target itself rather than an approximation of
 * it, because these are scores and split times, not decoration.
 */
export function countTo(target: number, sequence: RevealSequence, delaySeconds = 0): number {
  if (sequence.settled) return target;
  const span = Math.max(0.001, presentation.resultsCountSeconds);
  const progress = Math.max(0, Math.min(1, (sequence.elapsed - delaySeconds) / span));
  // Eased out, so the number decelerates onto its value instead of stopping dead on it.
  return target * (1 - (1 - progress) ** 3);
}
