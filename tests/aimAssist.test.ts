import { describe, expect, it } from 'vitest';
import { aimAssist } from '../src/content/config';
import {
  acquires, aimPoint, bearingTo, centredness, holds, lookSlowdown, magnetism, PITCH_LIMIT,
  type Vector3,
} from '../src/simulation/aimAssist';

const EYE: Vector3 = { x: 0, y: 2, z: 0 };
const TICK = 1 / 60;

/**
 * The simulation's own convention, restated so a sign error in the module cannot hide
 * behind a matching sign error in the test: forward is `(-sin(yaw), 0, -cos(yaw))`
 * scaled by the pitch cosine, with `y = sin(pitch)`.
 */
function forwardFromLook(yaw: number, pitch: number): Vector3 {
  const cosPitch = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cosPitch, y: Math.sin(pitch), z: -Math.cos(yaw) * cosPitch };
}

/** A target directly ahead down -Z at `distance`, offset sideways by `across`. */
function targetAt(distance: number, across = 0, height = 0): Vector3 {
  return { x: across, y: EYE.y + height - aimAssist.aimHeight, z: -distance };
}

describe('a bearing describes where a target is', () => {
  it('aims at centre mass rather than at the capsule origin', () => {
    expect(aimPoint({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2 + aimAssist.aimHeight, z: 3 });
  });

  it('reads dead centre as a cosine of one', () => {
    const bearing = bearingTo(EYE, forwardFromLook(0, 0), targetAt(20));
    expect(bearing.distance).toBeCloseTo(20, 6);
    expect(bearing.cosine).toBeCloseTo(1, 9);
  });

  it('reports the yaw and pitch that would point exactly at it', () => {
    const target = targetAt(18, 6, 4);
    const bearing = bearingTo(EYE, forwardFromLook(0, 0), target);
    // Point a fresh forward vector at the reported angles and the target is dead centre.
    const aimed = bearingTo(EYE, forwardFromLook(bearing.yaw, bearing.pitch), target);
    expect(aimed.cosine).toBeCloseTo(1, 9);
  });

  it('survives a target occupying the eye', () => {
    // Guarded with `|| 1` rather than an early return, because a NaN here would
    // propagate straight into the player's yaw and never be attributable again.
    const bearing = bearingTo(EYE, forwardFromLook(0, 0), { x: 0, y: EYE.y - aimAssist.aimHeight, z: 0 });
    expect(bearing.distance).toBe(0);
    expect(Number.isFinite(bearing.cosine)).toBe(true);
    expect(Number.isFinite(bearing.yaw)).toBe(true);
  });
});

describe('the cones acquire narrow and hold wide', () => {
  it('holds looser than it acquires, so a lock does not flicker', () => {
    // About 8 degrees to pick up and 13.75 to keep. One threshold makes a target at the
    // edge blink in and out as the player breathes, and the HUD lock blinks with it.
    expect(aimAssist.holdCosine).toBeLessThan(aimAssist.acquireCosine);
    const between = Math.acos((aimAssist.acquireCosine + aimAssist.holdCosine) / 2);
    const bearing = bearingTo(EYE, forwardFromLook(between, 0), targetAt(20));
    expect(acquires(bearing)).toBe(false);
    expect(holds(bearing)).toBe(true);
  });

  it('will not acquire past its range', () => {
    const bearing = bearingTo(EYE, forwardFromLook(0, 0), targetAt(aimAssist.range + 5));
    expect(bearing.cosine).toBeCloseTo(1, 6);
    expect(acquires(bearing)).toBe(false);
  });

  it('will not acquire a target on top of the eye', () => {
    expect(acquires(bearingTo(EYE, forwardFromLook(0, 0), { x: 0, y: EYE.y - aimAssist.aimHeight, z: 0 }))).toBe(false);
  });
});

describe('centredness and slowdown', () => {
  it('runs 0 at the edge of the cone to 1 dead centre', () => {
    expect(centredness(bearingTo(EYE, forwardFromLook(0, 0), targetAt(20)))).toBeCloseTo(1, 6);
    const edge = Math.acos(aimAssist.acquireCosine);
    expect(centredness(bearingTo(EYE, forwardFromLook(edge, 0), targetAt(20)))).toBeCloseTo(0, 6);
    // And clamped, so a target outside the cone is 0 rather than negative.
    expect(centredness(bearingTo(EYE, forwardFromLook(edge * 3, 0), targetAt(20)))).toBe(0);
  });

  it('leaves the look alone with nothing tracked', () => {
    expect(lookSlowdown(null)).toBe(1);
  });

  it('damps hardest with the target centred, and never past the authored scale', () => {
    const centre = lookSlowdown(bearingTo(EYE, forwardFromLook(0, 0), targetAt(20)));
    expect(centre).toBeCloseTo(aimAssist.slowdownScale, 6);
    const edge = Math.acos(aimAssist.acquireCosine);
    expect(lookSlowdown(bearingTo(EYE, forwardFromLook(edge, 0), targetAt(20)))).toBeCloseTo(1, 6);
    expect(centre).toBeGreaterThanOrEqual(aimAssist.slowdownScale);
  });
});

/**
 * The properties that separate this from an aimbot.
 *
 * Worth having as tests rather than as a comment, because both of them are the kind of
 * thing a later tuning pass could quietly undo: raising `maxTurnRate` or widening
 * `acquireCosine` are one-character edits, and neither announces what it costs.
 */
describe('magnetism is an assist, not an aimbot', () => {
  it('does nothing at all to a target outside the acquisition cone', () => {
    const outside = Math.acos(aimAssist.acquireCosine) * 1.4;
    const bearing = bearingTo(EYE, forwardFromLook(outside, 0), targetAt(20));
    expect(magnetism(bearing, outside, 0, TICK)).toBeNull();
  });

  it('cannot converge on a target it could not have acquired', () => {
    // Run a full second of ticks at a target well outside the cone. A pull expressed as
    // a fraction of the remaining error would close on this; a rate metred by centredness
    // never starts.
    const outside = Math.acos(aimAssist.acquireCosine) * 1.4;
    let yaw = outside;
    let pitch = 0;
    for (let tick = 0; tick < 60; tick += 1) {
      const next = magnetism(bearingTo(EYE, forwardFromLook(yaw, pitch), targetAt(20)), yaw, pitch, TICK);
      if (!next) continue;
      yaw = next.yaw;
      pitch = next.pitch;
    }
    expect(yaw).toBe(outside);
  });

  it('never moves the aim faster than the authored rate', () => {
    // Dead centre is where centredness -- and therefore the step -- is largest.
    const target = targetAt(20, 1.2, 0.6);
    const bearing = bearingTo(EYE, forwardFromLook(0, 0), target);
    const next = magnetism(bearing, 0, 0, TICK)!;
    const moved = Math.hypot(next.yaw - 0, next.pitch - 0);
    expect(moved).toBeLessThanOrEqual(aimAssist.maxTurnRate * TICK * Math.SQRT2 + 1e-9);
    expect(moved).toBeGreaterThan(0);
  });

  it('settles onto a target rather than oscillating past it', () => {
    const target = targetAt(20, 0.9, 0.4);
    let yaw = 0;
    let pitch = 0;
    let previous = Infinity;
    for (let tick = 0; tick < 240; tick += 1) {
      const bearing = bearingTo(EYE, forwardFromLook(yaw, pitch), target);
      const error = Math.acos(Math.min(1, bearing.cosine));
      // Monotonic: it closes and never opens back up.
      expect(error).toBeLessThanOrEqual(previous + 1e-9);
      previous = error;
      const next = magnetism(bearing, yaw, pitch, TICK);
      if (!next) break;
      yaw = next.yaw;
      pitch = next.pitch;
    }
    expect(previous).toBeLessThan(0.002);
  });

  it('respects the pitch clamp the simulation applies', () => {
    // Straight up, from a view already at the limit. Magnetism must not push past it.
    const above: Vector3 = { x: 0, y: EYE.y + 40, z: -0.01 };
    const bearing = bearingTo(EYE, forwardFromLook(0, PITCH_LIMIT), above);
    const next = magnetism(bearing, 0, PITCH_LIMIT, TICK);
    if (next) expect(Math.abs(next.pitch)).toBeLessThanOrEqual(PITCH_LIMIT);
  });
});
