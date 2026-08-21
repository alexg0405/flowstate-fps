import { aimAssist } from '../content/config';

/**
 * The aim assist, as arithmetic.
 *
 * All five parts of this used to live inline in `FlowSimulation`, and all five opened by
 * writing out the same eight lines: subtract the eye from the target, add `aimHeight`,
 * take a length, take a dot with the forward vector. Five copies of one calculation, each
 * with its own guard against a zero-length vector -- one used `|| 1`, one returned early
 * under 0.001, one did both -- which is the shape a bug hides in rather than a shape
 * anyone chose.
 *
 * Pulled out here for the reason `movementRules`, `lookNudge` and `citySkyline` are:
 * a rule about where the crosshair is allowed to move is worth being able to test without
 * standing up a physics world. What stays behind in the simulation is everything that
 * needs the world -- iterating live hostiles and casting a ray for a clear shot -- because
 * that is what actually requires it.
 *
 * ## What the assist is, and is not
 *
 * Two separate mechanisms, and keeping them separate is the whole design:
 *
 * - **Slowdown** damps the player's own look while a target is centred. It moves nothing.
 *   It is what makes a target easier to *hold*, and it cannot put the crosshair anywhere
 *   the player did not put it.
 * - **Magnetism** does move the crosshair, and is therefore capped as a *rate* rather
 *   than as a fraction of the remaining error. That distinction is load bearing: a
 *   fractional pull converges on any target from any angle given enough frames, which is
 *   an aimbot. A rate cap can settle a shot the player has already lined up and can never
 *   travel far enough to acquire one for them.
 *
 * Both are gated on ADS. Hip fire is fully manual, always.
 */

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Where a target sits relative to where the player is looking.
 *
 * `cosine` is computed against `distance || 1` so a target occupying the same point as
 * the eye yields a finite number rather than a NaN that would propagate into the player's
 * yaw. Callers still see the true `distance` and apply their own guard -- which is what
 * the original code did at three of its four call sites, and the fourth relied on the
 * `|| 1`. Both behaviours are preserved deliberately rather than unified, because
 * unifying them would change what the assist does at the degenerate distance.
 */
export interface AimBearing {
  /** Metres from the eye to the target's aim point. */
  distance: number;
  /** Cosine of the angle between the aim and the target. 1 is dead centre. */
  cosine: number;
  /** Unit vector from the eye to the aim point. */
  direction: Vector3;
  /** The yaw that would point exactly at it, in the simulation's convention. */
  yaw: number;
  /** The pitch that would point exactly at it. */
  pitch: number;
}

/** Aim for centre mass rather than for the origin of the capsule. */
export function aimPoint(target: Vector3): Vector3 {
  return { x: target.x, y: target.y + aimAssist.aimHeight, z: target.z };
}

export function bearingTo(eye: Vector3, forward: Vector3, target: Vector3): AimBearing {
  const point = aimPoint(target);
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const distance = Math.hypot(dx, dy, dz);
  const scale = distance || 1;
  return {
    distance,
    cosine: (dx * forward.x + dy * forward.y + dz * forward.z) / scale,
    direction: { x: dx / scale, y: dy / scale, z: dz / scale },
    // `forwardFromYaw` is `(-sin, -cos)`, so the yaw that points at a bearing is
    // `atan2(-dx, -dz)`. Pitch is measured against the horizontal run.
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz)),
  };
}

/** Inside the cone the assist may pick a target up in, and close enough to bother. */
export function acquires(bearing: AimBearing): boolean {
  return bearing.distance <= aimAssist.range
    && bearing.distance >= 0.001
    && bearing.cosine >= aimAssist.acquireCosine;
}

/**
 * Inside the wider cone an already-held target is kept in.
 *
 * Hold is looser than acquire on purpose -- about 13.75 degrees against 8. A single
 * threshold makes a target at the edge flicker in and out as the player breathes, and the
 * HUD lock flickers with it.
 */
export function holds(bearing: AimBearing): boolean {
  return bearing.distance <= aimAssist.range && bearing.cosine >= aimAssist.holdCosine;
}

/** 0 at the edge of the acquisition cone, 1 with the target dead centre. */
export function centredness(bearing: AimBearing): number {
  const span = 1 - aimAssist.acquireCosine;
  const value = (bearing.cosine - aimAssist.acquireCosine) / span;
  return Math.min(1, Math.max(0, value));
}

/**
 * The multiplier on the player's own look sensitivity. 1 is untouched.
 *
 * Strongest with the target centred, which is the correct shape: it is hardest to hold a
 * crosshair still exactly when it matters, and easiest to notice being fought when the
 * target is nowhere near.
 */
export function lookSlowdown(bearing: AimBearing | null): number {
  if (!bearing) return 1;
  return 1 - (1 - aimAssist.slowdownScale) * centredness(bearing);
}

/** The clamp the simulation applies to pitch, kept here so magnetism cannot exceed it. */
export const PITCH_LIMIT = 1.48;

/**
 * The worst cosine a candidate may have and still be considered, which is the edge of the
 * acquisition cone.
 *
 * Exported so the selection loop in the simulation can seed its running best without
 * reaching into `aimAssist` config itself. After this there is no aim-assist number left
 * outside this module, which is the point of the module existing: retuning the assist
 * should mean editing one file, and `git log` on that file should be the history of the
 * assist rather than the history of the simulation.
 */
export const ACQUIRE_FLOOR = aimAssist.acquireCosine;

/**
 * The new yaw and pitch after one tick of magnetism, or null when it does nothing.
 *
 * Returns absolute angles rather than deltas so the rate cap and the pitch clamp are
 * applied in one place. `step` is metred by centredness, so a target at the edge of the
 * cone gets almost no pull -- the assist helps most where the player has already done the
 * work, and least where doing the work for them would be doing the aiming.
 */
export function magnetism(
  bearing: AimBearing,
  yaw: number,
  pitch: number,
  dt: number,
): { yaw: number; pitch: number } | null {
  const step = aimAssist.maxTurnRate * dt * centredness(bearing);
  if (step <= 0) return null;
  const yawError = wrapAngle(bearing.yaw - yaw);
  const pitchError = bearing.pitch - pitch;
  return {
    yaw: yaw + clamp(yawError, -step, step),
    pitch: clamp(pitch + clamp(pitchError, -step, step), -PITCH_LIMIT, PITCH_LIMIT),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Must stay bit-identical to `FlowSimulation`'s copy, not merely equivalent to it.
 *
 * A modulo-based wrap is the same function mathematically and a different function in
 * floating point, and the simulation has a test proving identical trajectories from
 * identical input tapes. `atan2(sin, cos)` is what that test was recorded against.
 * Duplicated rather than shared because the simulation imports this module, so the
 * dependency cannot run the other way, and a yaw helper does not belong to the aim assist.
 */
function wrapAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}
