import type { LocomotionState } from '../../contracts';

/**
 * Perspective as an animation system.
 *
 * The reference this look is drawn from is shot from extremely low down with verticals
 * converging hard, and that choice is doing as much work as the palette: the camera is
 * part of the art direction rather than a window onto it. What the game had was one
 * effect -- eleven degrees of widening with speed -- and no vocabulary around it.
 *
 * The rule this module is built under is the one the repo has already written down twice:
 * **aim and camera control stay a precision instrument.** Everything here is a slow,
 * damped offset applied to the player's own field-of-view setting, driven off snapshot
 * state that the simulation produced; nothing here can move where a shot goes, and none
 * of it exists at all under reduced motion. The published advice on dynamic field of view
 * says the same thing from the comfort side: widen for speed, narrow for aiming, clamp the
 * extremes, ease the transitions.
 */

export const FOV_DIRECTION = {
  /** Degrees of widening at full speed. The effect that was already here. */
  speed: 11,
  /**
   * Airborne. Smaller than the speed kick and additive to it: leaving the ground is a
   * change of state rather than a change of pace, and it should read as a lift rather
   * than as an acceleration.
   */
  air: 3.4,
  /**
   * The hook. The widest thing in the vocabulary, because a grapple is the one move in
   * the game where the player is travelling a line they chose and watching it arrive.
   */
  grapple: 6.5,
  /** A slide is low and fast, and a little wider sells both. */
  slide: 4,
  /**
   * Landing, and the only *negative* term here. A frame that compresses on impact is the
   * oldest trick in animation and it costs nothing; the important half is that it
   * recovers on its own damping rather than on the standing one, so it snaps in and eases
   * out instead of wallowing.
   */
  landing: 7.5,
  /** How fast the frame follows, normally and while recovering from a landing. */
  damping: 8,
  landingDamping: 15,
  /** How fast a landing impulse decays, per second. */
  landingDecay: 6.5,
  /** Nothing may push the frame further than this either way. */
  limit: 14,
} as const;

export interface CameraDirectionState {
  /** Speed ramp, 0 to 1, already suppressed by aiming. */
  drive: number;
  locomotion: LocomotionState;
  /** A decaying 0-to-1 impulse, set on the frame the player touched down. */
  landing: number;
  reducedMotion: boolean;
}

export interface CameraDirection {
  /** Degrees to add to the player's own field of view. */
  offset: number;
  /** How fast to move towards it. */
  damping: number;
}

/**
 * What the frame should be doing, given what the player is doing. Pure, and the reason it
 * is pure is that everything else about the camera lives inside `GameRenderer`, which
 * needs WebGL to construct and therefore cannot be reached from a test.
 */
export function directCamera(state: CameraDirectionState): CameraDirection {
  if (state.reducedMotion) return { offset: 0, damping: FOV_DIRECTION.damping };
  let offset = Math.max(0, Math.min(1, state.drive)) * FOV_DIRECTION.speed;
  if (state.locomotion === 'grappling') offset += FOV_DIRECTION.grapple;
  else if (state.locomotion === 'airborne' || state.locomotion === 'dashing') offset += FOV_DIRECTION.air;
  else if (state.locomotion === 'sliding') offset += FOV_DIRECTION.slide;
  const landing = Math.max(0, Math.min(1, state.landing));
  offset -= landing * FOV_DIRECTION.landing;
  return {
    offset: Math.max(-FOV_DIRECTION.limit, Math.min(FOV_DIRECTION.limit, offset)),
    // A compression that recovered at the standing rate would read as the frame drifting
    // back rather than as an impact.
    damping: landing > 0.02 ? FOV_DIRECTION.landingDamping : FOV_DIRECTION.damping,
  };
}

/** Whether this frame's locomotion change is the player touching down. */
export function isTouchdown(previous: LocomotionState | null, current: LocomotionState): boolean {
  if (previous === null || current === previous) return false;
  const airborne = previous === 'airborne' || previous === 'dashing' || previous === 'grappling';
  return airborne && (current === 'grounded' || current === 'crouching' || current === 'sliding');
}
