import { lookNudge as profile } from '../content/config';
import type { Vec3, VistaHint } from '../contracts';

/**
 * A soft nudge on where the player is looking, so an authored composition is actually
 * in frame when they run past it.
 *
 * The route's vistas are composed for a view pitched 18 to 40 degrees up, because
 * `settings.fov` is 92 -- a *vertical* angle -- so a level camera spends the bottom half
 * of every frame on the ground plane, and the reference this game is chasing has almost
 * no ground in it. A player running forward holds a pitch of zero. Without something
 * closing that gap the compositions exist and nobody sees them.
 *
 * This lives in the simulation rather than the presentation layer, and that is not a
 * technicality. In first person the camera *is* the aim: a pitch applied in the renderer
 * and not in the simulation would point the crosshair somewhere the shots do not go.
 * `applyAimMagnetism` already establishes the shape -- a deterministic, rate-clamped
 * adjustment to the player's own look, gated on a condition -- and this is the same
 * class of thing with a different trigger.
 *
 * ## What makes it soft
 *
 * The failure mode to avoid is the one this project already rejected once, when a timer
 * put a gun in the player's hands and changed what the attack button meant underneath
 * them. A camera that pans on its own is that mistake with a bigger surface. So:
 *
 * - **Any look input abandons the nudge instantly**, and locks it out for
 *   `inputLockSeconds`. Not "damps it" -- abandons it. The moment the player expresses an
 *   opinion about where to look, they own the aim and the nudge forgets its debt rather
 *   than unwinding it under them.
 * - **It never touches yaw.** Pitch is where you are looking; yaw is where you are
 *   going. Taking yaw is taking steering.
 * - **It is capped in total displacement**, not just in rate, so it can never carry the
 *   view somewhere the player would not have gone. Anything the cap cannot reach has to
 *   be earned by geometry instead -- a dead end at the foot of a tower, where there is
 *   nothing to look at but up.
 * - **Nothing during a fight.** A hostile inside `disarmRange` disarms it outright.
 * - **Nothing under reduced motion**, which is both a media query and a save toggle.
 *
 * ## Giving the aim back
 *
 * The nudge owns its contribution and returns it. `offset` is how much of the player's
 * pitch the nudge put there; once no hint is in range it unwinds at `decayRate` until
 * the player is looking exactly where they were. The unwind only ever runs while the
 * player is not looking, so it cannot push a view the player is steering.
 */
export interface LookNudgeState {
  /** Radians of the player's pitch that this nudge is responsible for. */
  offset: number;
  /** Seconds before the nudge may act again, after the player looked. */
  lockout: number;
}

export interface LookNudgeFrame {
  position: Vec3;
  /** The player's pitch as it stands after their own input this tick. */
  pitch: number;
  /** Magnitude of this tick's look input, in raw input units. */
  lookInput: number;
  /** Distance to the nearest live hostile, or `Infinity` when the route is quiet. */
  nearestHostile: number;
  reducedMotion: boolean;
  hints: readonly VistaHint[];
  dt: number;
}

export interface LookNudgeResult extends LookNudgeState {
  /** Radians to add to the player's pitch this tick. */
  delta: number;
  /** Which hint is driving, for the HUD and for tests. */
  hintId: string | null;
}

export const idleLookNudge: LookNudgeState = { offset: 0, lockout: 0 };

/**
 * The hint in range whose zone the player is deepest inside.
 *
 * Deepest rather than nearest, measured as a fraction of each hint's own radius, so a
 * small precise zone at a doorway wins over a large loose one covering the street it
 * opens onto.
 */
export function activeHint(position: Vec3, hints: readonly VistaHint[]): { hint: VistaHint; strength: number } | null {
  let best: { hint: VistaHint; strength: number; depth: number } | null = null;
  for (const hint of hints) {
    const dx = position[0] - hint.at[0];
    const dy = position[1] - hint.at[1];
    const dz = position[2] - hint.at[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance >= hint.radius) continue;
    // Two numbers, not one. `depth` picks the hint and `strength` sets its rate, and they
    // have to be separate: strength saturates at 1 through the inner two thirds of a
    // zone, so choosing on it made every overlapping pair a tie broken by array order.
    // Depth does not saturate, so a tight zone at a doorway still wins over a loose one
    // covering the street it opens onto.
    const depth = 1 - distance / hint.radius;
    // Full rate through the middle, easing off over the outer third, so walking into a
    // zone does not start the drift with a step.
    const strength = Math.min(1, depth * 3);
    if (!best || depth > best.depth) best = { hint, strength, depth };
  }
  return best ? { hint: best.hint, strength: best.strength } : null;
}

export function stepLookNudge(state: LookNudgeState, frame: LookNudgeFrame): LookNudgeResult {
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

  // The player looked. They own the aim; drop the debt rather than unwinding it under
  // them, and stay out of the way for a moment in case they are still adjusting.
  if (frame.lookInput > profile.inputEpsilon) {
    return { offset: 0, lockout: profile.inputLockSeconds, delta: 0, hintId: null };
  }

  const lockout = Math.max(0, state.lockout - frame.dt);
  const unwind = (): LookNudgeResult => {
    if (state.offset === 0) return { offset: 0, lockout, delta: 0, hintId: null };
    const step = Math.min(Math.abs(state.offset), profile.decayRate * frame.dt);
    const delta = state.offset > 0 ? -step : step;
    return { offset: state.offset + delta, lockout, delta, hintId: null };
  };

  if (lockout > 0) return unwind();
  if (frame.reducedMotion) return unwind();
  if (frame.nearestHostile < profile.disarmRange) return unwind();

  const active = activeHint(frame.position, frame.hints);
  if (!active) return unwind();

  // Where the nudge would like the view, bounded by how far it is ever allowed to move
  // it. The bound is on the accumulated offset, so the ceiling is the same whether the
  // player arrives already looking up or dead level.
  const want = active.hint.pitch - frame.pitch;
  const room = profile.maxPitchOffset - state.offset;
  const step = profile.rate * frame.dt * active.strength;
  const delta = clamp(clamp(want, -step, step), -profile.maxPitchOffset - state.offset, Math.max(0, room));
  if (delta === 0) return { offset: state.offset, lockout, delta: 0, hintId: active.hint.id };
  return { offset: state.offset + delta, lockout, delta, hintId: active.hint.id };
}
