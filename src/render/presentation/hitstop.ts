import type { GameEvent } from '../../contracts';
import { hitstop as defaultTuning } from '../../content/config';

export type HitstopTuning = typeof defaultTuning;

/** Freeze shorter than this is over. Well under a frame at any rate worth drawing. */
const RESIDUE_SECONDS = 1e-6;

/**
 * How long a batch of events asks the frame to freeze for, in seconds. Zero means
 * nothing in it earned a freeze.
 *
 * Kept as a pure function for the same reason `ResolutionController` and
 * `visualBatching` are: `GameRenderer` needs WebGL to construct, so a decision that
 * lives inside it cannot be reached from a unit test, and this one decides how often
 * the whole frame stops.
 *
 * The `hit` event does not say what dealt it and does not need to. A swing that landed
 * publishes a `melee` event naming its target in the same batch as the `hit` it
 * caused, so the two can be correlated here rather than by widening the contract.
 */
export function freezeSecondsFor(
  events: readonly GameEvent[],
  playerId: number | undefined,
  tuning: HitstopTuning = defaultTuning,
): number {
  const struck = new Set<number>();
  for (const event of events) {
    if (event.kind === 'melee' && event.targetEntityId !== undefined) struck.add(event.targetEntityId);
  }

  let longest = 0;
  for (const event of events) {
    const target = event.targetEntityId ?? event.entityId;
    if (target === undefined || target === playerId) continue;
    // Any kill takes the ceiling, however it was dealt. It is the one moment in the
    // loop that is always worth the whole freeze.
    if (event.kind === 'kill') {
      longest = tuning.maxSeconds;
      continue;
    }
    if (event.kind !== 'hit' || !struck.has(target)) continue;
    const scale = Math.min(1, Math.max(0, (event.value ?? 0) / tuning.fullDamage));
    longest = Math.max(longest, tuning.minSeconds + (tuning.maxSeconds - tuning.minSeconds) * scale);
  }
  return longest;
}

/**
 * Runs the freeze. Fed the *real* frame delta, and asked whether the presentation
 * clock should advance by it or by nothing at all.
 */
export class HitstopController {
  private remaining = 0;
  /** Running seconds since the last freeze ended. Starts open so the first blow lands. */
  private sinceFreeze = Number.POSITIVE_INFINITY;

  constructor(private readonly tuning: HitstopTuning = defaultTuning) {}

  /** Seconds of freeze left. Zero when the frame is running normally. */
  get seconds(): number {
    return this.remaining;
  }

  get frozen(): boolean {
    return this.remaining > 0;
  }

  /**
   * Advances the freeze by real time, then arms a new one from this frame's events.
   * In that order, so a blow that lands this frame freezes this frame.
   */
  update(events: readonly GameEvent[], playerId: number | undefined, frameSeconds: number, enabled: boolean): boolean {
    if (!enabled) {
      // Turning the setting off mid-freeze has to release it, not strand it.
      this.remaining = 0;
      this.sinceFreeze = Number.POSITIVE_INFINITY;
      return false;
    }
    if (this.remaining > 0) {
      // Snapped to zero rather than compared against it. Six frames of 1/60 does not
      // subtract exactly to nothing in binary floating point -- it leaves about 1e-17
      // behind, which is one whole extra frozen frame for no reason a player could
      // name.
      const next = this.remaining - frameSeconds;
      this.remaining = next <= RESIDUE_SECONDS ? 0 : next;
      if (this.remaining === 0) this.sinceFreeze = 0;
    } else {
      this.sinceFreeze += frameSeconds;
    }

    const requested = freezeSecondsFor(events, playerId, this.tuning);
    // Refused rather than shortened while the gap is still closing: a stutter that
    // arrives on every hit of a crowd is worse than one that arrives on some of them.
    if (requested > 0 && this.sinceFreeze >= this.tuning.refractorySeconds) {
      this.remaining = Math.max(this.remaining, requested);
    }
    return this.frozen;
  }

  reset(): void {
    this.remaining = 0;
    this.sinceFreeze = Number.POSITIVE_INFINITY;
  }
}
