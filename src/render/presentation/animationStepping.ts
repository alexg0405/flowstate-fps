/**
 * Animating on twos, in a game that must not feel like it.
 *
 * Traditional animation holds each drawing for two frames of twenty-four, and
 * Spider-Verse put the technique in front of a mainstream audience by using it
 * *narratively* -- Miles is stepped where Peter is not, and moves to smooth frames as he
 * gains competence. What it buys is weight: a pose that lasts long enough to read.
 *
 * What it costs, in a shooter, is everything -- if it touches the wrong thing. So the
 * split here is strict and it maps onto a boundary this codebase already has. The
 * simulation steps at a fixed 1/60 s and `simulationReplay` proves identical trajectories
 * from identical input tapes; presentation interpolates between those steps. Stepping is
 * therefore a *presentation* decision and can be applied per presenter:
 *
 * - **Stepped:** hostile poses. The clip advances in twelfths of a second.
 * - **Never stepped:** the camera, aim, the viewmodel, hit registration, world positions,
 *   and the mix -- which was just given tick-accurate scheduling and would lose it.
 *
 * Note that a hostile's *position* is not stepped either, only its pose. A figure that
 * teleported twelve times a second would be a figure the player cannot lead a shot on,
 * and combat readability outranks the effect.
 */

/** Poses a second. Twelve is the classic "on twos" of a twenty-four frame film. */
export const POSE_HZ = 12;

export interface SteppedAdvance {
  /** Seconds to actually advance the animation by, this frame. Often zero. */
  advance: number;
  /** Seconds carried over to the next frame. Always under one step. */
  pending: number;
}

/**
 * Turns a continuous frame delta into whole animation steps.
 *
 * The remainder is carried rather than dropped, which is the whole of the correctness
 * here: dropping it would make animation run slow by up to a step per frame, and at
 * 144 Hz that is most of the animation.
 */
export function stepAdvance(pending: number, hz = POSE_HZ): SteppedAdvance {
  if (!Number.isFinite(pending) || pending <= 0) return { advance: 0, pending: Math.max(0, pending || 0) };
  if (hz <= 0) return { advance: pending, pending: 0 };
  const steps = Math.floor(pending * hz);
  if (steps <= 0) return { advance: 0, pending };
  const advance = steps / hz;
  return { advance, pending: pending - advance };
}

/**
 * A continuous clock quantised to the same grid, for pose maths driven off absolute time
 * rather than off a delta.
 */
export function steppedTime(time: number, hz = POSE_HZ): number {
  if (hz <= 0 || !Number.isFinite(time)) return time;
  return Math.floor(time * hz) / hz;
}
