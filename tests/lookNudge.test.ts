import { describe, expect, it } from 'vitest';
import { lookNudge as profile } from '../src/content/config';
import type { InputFrame, VistaHint } from '../src/contracts';
import { cookLevel } from '../src/content/defaultLevel';
import { vistaBlockout, vistaCone } from '../src/content/vistaBlockout';
import { FlowSimulation } from '../src/simulation/FlowSimulation';
import { activeHint, idleLookNudge, stepLookNudge, type LookNudgeFrame } from '../src/simulation/lookNudge';

const TICK = 1 / 60;
const DEG = Math.PI / 180;

const hint: VistaHint = { id: 'hint-test', at: [0, 0, 0], radius: 10, yaw: 0, pitch: 40 * DEG };

function frame(overrides: Partial<LookNudgeFrame> = {}): LookNudgeFrame {
  return {
    position: [0, 0, 0],
    pitch: 0,
    lookInput: 0,
    nearestHostile: Infinity,
    reducedMotion: false,
    hints: [hint],
    dt: TICK,
    ...overrides,
  };
}

/** Runs the nudge for `seconds`, feeding its own offset back as the player's pitch. */
function settle(seconds: number, overrides: Partial<LookNudgeFrame> = {}) {
  let state = idleLookNudge;
  let pitch = overrides.pitch ?? 0;
  for (let tick = 0; tick < Math.round(seconds / TICK); tick += 1) {
    const result = stepLookNudge(state, frame({ ...overrides, pitch }));
    state = { offset: result.offset, lockout: result.lockout };
    pitch += result.delta;
  }
  return { ...state, pitch };
}

describe('the nudge lifts the view toward an authored vista', () => {
  it('drifts toward the hint while the player is not looking', () => {
    const after = settle(1);
    expect(after.pitch).toBeGreaterThan(6 * DEG);
    expect(after.pitch).toBeLessThan(profile.rate * 1.05);
    expect(after.offset).toBeCloseTo(after.pitch, 6);
  });

  it('stops at the cap however long it is given', () => {
    // The hint asks for 40 degrees. The nudge is allowed 18 and no more, which is the
    // difference between a hint and a cutscene.
    const after = settle(20);
    expect(after.offset).toBeCloseTo(profile.maxPitchOffset, 4);
    expect(after.pitch).toBeLessThanOrEqual(profile.maxPitchOffset + 1e-6);
  });

  it('eases in over the outer third of the zone rather than starting with a step', () => {
    const edge = activeHint([0, 0, 9.5], [hint]);
    const middle = activeHint([0, 0, 1], [hint]);
    expect(edge!.strength).toBeLessThan(0.2);
    expect(middle!.strength).toBe(1);
    expect(activeHint([0, 0, 11], [hint])).toBeNull();
  });

  it('prefers the zone the player is deepest inside, not the nearest centre', () => {
    const loose: VistaHint = { id: 'loose', at: [0, 0, 0], radius: 40, yaw: 0, pitch: 5 * DEG };
    const tight: VistaHint = { id: 'tight', at: [0, 0, 6], radius: 8, yaw: 0, pitch: 30 * DEG };
    // Six metres from `loose`'s centre and dead on `tight`'s: the precise zone wins.
    expect(activeHint([0, 0, 6], [loose, tight])!.hint.id).toBe('tight');
  });
});

describe('the nudge yields to the player', () => {
  it('abandons its offset the moment the player looks, rather than unwinding it', () => {
    const held = settle(2);
    expect(held.offset).toBeGreaterThan(5 * DEG);
    const result = stepLookNudge(held, frame({ pitch: held.pitch, lookInput: 0.01 }));
    // No delta: the view stays exactly where the player just put it, and the nudge
    // forgets it was ever responsible for any of it.
    expect(result.delta).toBe(0);
    expect(result.offset).toBe(0);
    expect(result.lockout).toBeCloseTo(profile.inputLockSeconds, 6);
  });

  it('stays out of the way for the whole lockout, then resumes', () => {
    const locked = { offset: 0, lockout: profile.inputLockSeconds };
    const midway = stepLookNudge(locked, frame({ dt: profile.inputLockSeconds / 2 }));
    expect(midway.delta).toBe(0);
    expect(midway.hintId).toBeNull();
    const expired = stepLookNudge({ offset: 0, lockout: 0.0001 }, frame());
    expect(expired.delta).toBeGreaterThan(0);
    expect(expired.hintId).toBe('hint-test');
  });

  it('ignores a resting hand', () => {
    const result = stepLookNudge(idleLookNudge, frame({ lookInput: profile.inputEpsilon / 2 }));
    expect(result.delta).toBeGreaterThan(0);
  });
});

describe('the nudge disarms itself', () => {
  it('does nothing at all under reduced motion', () => {
    const after = settle(3, { reducedMotion: true });
    expect(after.offset).toBe(0);
    expect(after.pitch).toBe(0);
  });

  it('gives the aim back when a hostile is close, and does not fight the assist', () => {
    const held = settle(2);
    const result = stepLookNudge(held, frame({ pitch: held.pitch, nearestHostile: profile.disarmRange - 1 }));
    expect(result.hintId).toBeNull();
    expect(result.delta).toBeLessThan(0);
  });

  it('unwinds to exactly zero once the vista is behind the player', () => {
    const held = settle(2);
    expect(held.offset).toBeGreaterThan(5 * DEG);
    let state = { offset: held.offset, lockout: held.lockout };
    let pitch = held.pitch;
    for (let tick = 0; tick < 240; tick += 1) {
      const result = stepLookNudge(state, frame({ pitch, position: [0, 0, 40] }));
      state = { offset: result.offset, lockout: result.lockout };
      pitch += result.delta;
    }
    // All of it handed back, and the player is looking where they were before.
    expect(state.offset).toBeCloseTo(0, 8);
    expect(pitch).toBeCloseTo(0, 6);
  });

  it('gives it back faster than it took it', () => {
    expect(profile.decayRate).toBeGreaterThan(profile.rate);
  });
});

describe('the nudge in the simulation', () => {
  /** Steps the blockout with the player standing still in a vista zone. */
  async function stand(ticks: number, look: [number, number] = [0, 0]) {
    const simulation = new FlowSimulation();
    const level = cookLevel(vistaBlockout);
    const reveal = vistaCone('reveal')!;
    level.spawns = level.spawns.map((spawn) => (spawn.kind === 'player'
      ? { ...spawn, position: reveal.origin, rotationY: reveal.yaw }
      : spawn));
    await simulation.loadLevel(level);
    let output = simulation.step({ tick: 1, held: 0, pressed: 0, released: 0, look } satisfies InputFrame, TICK);
    for (let tick = 2; tick <= ticks; tick += 1) {
      output = simulation.step({ tick, held: 0, pressed: 0, released: 0, look } satisfies InputFrame, TICK);
    }
    const { camera, entities } = output.snapshot;
    simulation.dispose();
    return { camera, yaw: entities[0].rotationY };
  }

  it('raises the pitch of a player standing in the reveal, and leaves the heading alone', async () => {
    const before = await stand(2);
    const after = await stand(90);
    expect(after.camera.pitch).toBeGreaterThan(before.camera.pitch + 5 * DEG);
    expect(after.camera.pitch).toBeLessThanOrEqual(profile.maxPitchOffset + 1e-6);
    // Pitch is where you are looking; yaw is where you are going, and it is untouched.
    expect(after.yaw).toBeCloseTo(before.yaw, 9);
  });

  it('does not move a player who is looking', async () => {
    // Turning, not pitching: `look[1]` is zero, so any pitch at all is the nudge.
    const after = await stand(90, [0.004, 0]);
    expect(after.camera.pitch).toBeCloseTo(0, 9);
  });

  it('lifts the view at the White Line spawn, and stops at what the hint asked for', async () => {
    const { defaultLevel } = await import('../src/content/defaultLevel');
    const canyon = defaultLevel.vistaHints.find((entry) => entry.id === 'hint-canyon')!;
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(defaultLevel));
    let output = simulation.step({ tick: 1, held: 0, pressed: 0, released: 0, look: [0, 0] }, TICK);
    for (let tick = 2; tick <= 180; tick += 1) {
      output = simulation.step({ tick, held: 0, pressed: 0, released: 0, look: [0, 0] }, TICK);
    }
    // The spawn stands inside `hint-canyon`, which asks for 16 degrees -- under the
    // 18-degree cap, so the nudge delivers all of it and then holds.
    expect(canyon.pitch).toBeLessThan(profile.maxPitchOffset);
    expect(output.snapshot.camera.pitch).toBeCloseTo(canyon.pitch, 4);
    simulation.dispose();
  });
});
