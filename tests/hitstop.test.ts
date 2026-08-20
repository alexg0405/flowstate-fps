import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../src/contracts';
import { hitstop } from '../src/content/config';
import { freezeSecondsFor, HitstopController } from '../src/render/presentation/hitstop';

const PLAYER = 1;
const HOSTILE = 2;
let nextId = 0;

function event(kind: GameEvent['kind'], overrides: Partial<GameEvent> = {}): GameEvent {
  nextId += 1;
  return { id: nextId, tick: 1, kind, ...overrides };
}

/** A swing that landed, and the damage it dealt, as the simulation publishes them. */
function slash(value: number, target = HOSTILE): GameEvent[] {
  return [
    event('melee', { sourceEntityId: PLAYER, targetEntityId: target }),
    event('hit', { targetEntityId: target, value, sourceEntityId: PLAYER }),
  ];
}

/** A round that landed. Same `hit`, no swing to correlate it with. */
function shot(value: number, target = HOSTILE): GameEvent[] {
  return [
    event('shot', { sourceEntityId: PLAYER }),
    event('impact', { targetEntityId: target, sourceEntityId: PLAYER }),
    event('hit', { targetEntityId: target, value, sourceEntityId: PLAYER }),
  ];
}

describe('what earns a freeze', () => {
  it('freezes on a landed swing, scaled by the damage it dealt', () => {
    const clean = freezeSecondsFor(slash(hitstop.fullDamage), PLAYER);
    expect(clean).toBeCloseTo(hitstop.maxSeconds, 6);

    // A shield arc ate most of it, so the frame barely stops -- the same cue the grey
    // hitmarker gives, said again in the frame.
    const deflected = freezeSecondsFor(slash(11.7), PLAYER);
    expect(deflected).toBeGreaterThan(hitstop.minSeconds);
    expect(deflected).toBeLessThan(hitstop.minSeconds + (hitstop.maxSeconds - hitstop.minSeconds) * 0.25);
    expect(clean).toBeGreaterThan(deflected);
  });

  it('never freezes for less than the floor or more than the ceiling', () => {
    expect(freezeSecondsFor(slash(0.01), PLAYER)).toBeGreaterThanOrEqual(hitstop.minSeconds);
    expect(freezeSecondsFor(slash(9000), PLAYER)).toBeCloseTo(hitstop.maxSeconds, 6);
  });

  it('does not freeze for ordinary gunfire', () => {
    // The arithmetic that makes this necessary: an SMG at 1020 rounds a minute lands
    // one every 3.5 frames, and a three-frame freeze per round is not hitstop.
    expect(freezeSecondsFor(shot(20), PLAYER)).toBe(0);
    expect(freezeSecondsFor(shot(62), PLAYER)).toBe(0);
  });

  it('freezes at the ceiling on any kill, however it was dealt', () => {
    expect(freezeSecondsFor([...shot(62), event('kill', { targetEntityId: HOSTILE })], PLAYER)).toBeCloseTo(hitstop.maxSeconds, 6);
  });

  it('ignores damage the player took', () => {
    // Incoming fire already shakes the camera and raises a bearing wedge. Freezing the
    // frame on it would take the player's view away at the moment they need it most.
    expect(freezeSecondsFor([event('hit', { targetEntityId: PLAYER, value: 40 })], PLAYER)).toBe(0);
    expect(freezeSecondsFor([event('kill', { targetEntityId: PLAYER })], PLAYER)).toBe(0);
    expect(freezeSecondsFor([event('death', { entityId: PLAYER })], PLAYER)).toBe(0);
  });

  it('takes the longest freeze in a batch rather than their sum', () => {
    // A shotgun shell resolves eight traces in one tick. Eight freezes end-to-end
    // would be half a second of stopped frame for one trigger pull.
    const shell = [...slash(20), ...slash(20), ...slash(20)];
    expect(freezeSecondsFor(shell, PLAYER)).toBeCloseTo(freezeSecondsFor(slash(20), PLAYER), 6);
  });

  it('does not correlate a swing with a hit on someone else', () => {
    const events = [
      event('melee', { sourceEntityId: PLAYER, targetEntityId: HOSTILE }),
      event('hit', { targetEntityId: 3, value: 62, sourceEntityId: PLAYER }),
    ];
    expect(freezeSecondsFor(events, PLAYER)).toBe(0);
  });

  it('gives a whiff nothing', () => {
    expect(freezeSecondsFor([event('melee', { sourceEntityId: PLAYER })], PLAYER)).toBe(0);
  });
});

describe('running the freeze', () => {
  const FRAME = 1 / 60;

  it('holds the presentation clock for the requested time, then releases it', () => {
    const controller = new HitstopController();
    expect(controller.update(slash(hitstop.fullDamage), PLAYER, FRAME, true)).toBe(true);
    expect(controller.seconds).toBeCloseTo(hitstop.maxSeconds, 6);

    let frames = 0;
    while (controller.frozen && frames < 60) {
      controller.update([], PLAYER, FRAME, true);
      frames += 1;
    }
    // Six frames of freeze, counted in frames because that is the unit the brief and
    // the player both use.
    expect(frames).toBe(Math.round(hitstop.maxSeconds * 60));
    expect(controller.seconds).toBe(0);
  });

  it('refuses a second freeze until the refractory gap has run', () => {
    const controller = new HitstopController();
    controller.update(slash(hitstop.fullDamage), PLAYER, FRAME, true);
    while (controller.frozen) controller.update([], PLAYER, FRAME, true);

    // Immediately after the freeze: refused, so a crowd cannot stack stutters into
    // permanent slow motion.
    expect(controller.update(slash(hitstop.fullDamage), PLAYER, FRAME, true)).toBe(false);

    // Once the gap has run, armed again.
    for (let frame = 0; frame < Math.ceil(hitstop.refractorySeconds * 60); frame += 1) {
      controller.update([], PLAYER, FRAME, true);
    }
    expect(controller.update(slash(hitstop.fullDamage), PLAYER, FRAME, true)).toBe(true);
  });

  it('lets consecutive slashes each freeze, because the blade is slower than the gap', () => {
    // Recovery between swings is 0.24 s and the gap is 0.1 s, so a player holding the
    // blade down gets the feedback on every swing rather than every other one.
    const controller = new HitstopController();
    const slashFrames = Math.ceil(0.24 * 60);
    let froze = 0;
    for (let swing = 0; swing < 4; swing += 1) {
      if (controller.update(slash(hitstop.fullDamage), PLAYER, FRAME, true)) froze += 1;
      for (let frame = 1; frame < slashFrames; frame += 1) controller.update([], PLAYER, FRAME, true);
    }
    expect(froze).toBe(4);
  });

  it('does nothing at all with reduced motion on, and releases a live freeze', () => {
    const controller = new HitstopController();
    expect(controller.update(slash(hitstop.fullDamage), PLAYER, FRAME, false)).toBe(false);
    expect(controller.seconds).toBe(0);

    // Turned on mid-freeze, the freeze has to end rather than be stranded.
    controller.update(slash(hitstop.fullDamage), PLAYER, FRAME, true);
    expect(controller.frozen).toBe(true);
    expect(controller.update([], PLAYER, FRAME, false)).toBe(false);
    expect(controller.seconds).toBe(0);
  });

  it('lets the very first blow of a run freeze', () => {
    // The gap is measured from the last freeze, and there has not been one.
    expect(new HitstopController().update(slash(40), PLAYER, FRAME, true)).toBe(true);
  });

  it('is unaffected by how long the frame took', () => {
    // A freeze is a duration, not a frame count, so a 30 Hz display sees the same
    // stop as a 144 Hz one rather than twice as much of it.
    const total = (frameSeconds: number): number => {
      const controller = new HitstopController();
      controller.update(slash(hitstop.fullDamage), PLAYER, frameSeconds, true);
      let elapsed = 0;
      while (controller.frozen && elapsed < 1) {
        controller.update([], PLAYER, frameSeconds, true);
        elapsed += frameSeconds;
      }
      return elapsed;
    };
    expect(total(1 / 144)).toBeCloseTo(hitstop.maxSeconds, 2);
    expect(total(1 / 30)).toBeCloseTo(hitstop.maxSeconds, 1);
  });
});
