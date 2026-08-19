import { describe, expect, it } from 'vitest';
import { Action, type InputFrame, type LegacyLevelDocumentV1, type LevelPrimitive, type Vec3 } from '../src/contracts';
import { aimAssist, botColliderBottom, movementProfile } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function box(id: string, position: Vec3, scale: Vec3, surface: LevelPrimitive['surface'] = 'default'): LevelPrimitive {
  return { id, kind: 'box', transform: { position, rotation: [0, 0, 0], scale }, color: '#8899aa', collision: true, surface };
}

const FLOOR = box('floor', [0, -0.5, -20], [40, 1, 80]);

function level(primitives: LevelPrimitive[], overrides: Partial<LegacyLevelDocumentV1> = {}): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'control-course',
    name: 'Control Course',
    units: 'meters',
    primitives,
    spawns: [{ id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 }],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -200],
    ...overrides,
  };
}

async function start(document: LegacyLevelDocumentV1): Promise<FlowSimulation> {
  const simulation = new FlowSimulation();
  await simulation.loadLevel(cookLevel(document));
  return simulation;
}

function frame(tick: number, patch: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...patch };
}

/** Spawns rest just above the floor, so let the capsule settle before asserting. */
function settle(simulation: FlowSimulation, ticks = 4): number {
  for (let tick = 1; tick <= ticks; tick += 1) simulation.step(frame(tick), TICK);
  return ticks + 1;
}

describe('momentum-free ground movement', () => {
  it('reaches full speed on the first tick and stops the moment input is released', async () => {
    const simulation = await start(level([FLOOR]));
    const tick = settle(simulation);
    let output = simulation.step(frame(tick, { held: Action.Forward }), TICK);
    expect(output.snapshot.player.speed).toBeCloseTo(movementProfile.walkSpeed, 3);

    output = simulation.step(frame(tick + 1, { held: Action.Forward | Action.Sprint }), TICK);
    expect(output.snapshot.player.speed).toBeCloseTo(movementProfile.sprintSpeed, 3);

    output = simulation.step(frame(tick + 2, { released: Action.Forward | Action.Sprint }), TICK);
    expect(output.snapshot.player.speed).toBeCloseTo(0, 6);
    simulation.dispose();
  });

  it('reverses instantly instead of decelerating through zero', async () => {
    const simulation = await start(level([FLOOR]));
    const tick = settle(simulation);
    simulation.step(frame(tick, { held: Action.Forward | Action.Sprint }), TICK);
    const output = simulation.step(frame(tick + 1, { held: Action.Back | Action.Sprint }), TICK);
    expect(output.snapshot.entities[0].velocity[2]).toBeCloseTo(movementProfile.sprintSpeed, 3);
    simulation.dispose();
  });

  it('leaves airborne momentum alone so dash and jump arcs survive', async () => {
    const simulation = await start(level([FLOOR]));
    const tick = settle(simulation);
    // Ground dash, then jump-cancel out of it and stop steering.
    simulation.step(frame(tick, { held: Action.Forward, pressed: Action.Dash }), TICK);
    simulation.step(frame(tick + 1, { held: Action.Forward }), TICK);
    let output = simulation.step(frame(tick + 2, { held: Action.Forward, pressed: Action.Jump }), TICK);
    const launchSpeed = output.snapshot.player.speed;
    expect(launchSpeed).toBeGreaterThan(movementProfile.sprintSpeed);

    for (let step = tick + 3; step < tick + 11; step += 1) output = simulation.step(frame(step), TICK);
    expect(output.snapshot.entities[0].grounded).toBe(false);
    expect(output.snapshot.player.speed).toBeCloseTo(launchSpeed, 3);
    simulation.dispose();
  });
});

describe('jump doubles as the dash key', () => {
  it('reads a second press inside the window as a dash', async () => {
    const simulation = await start(level([FLOOR]));
    const tick = settle(simulation);
    let output = simulation.step(frame(tick, { held: Action.Forward, pressed: Action.Jump }), TICK);
    expect(output.snapshot.player.locomotion).not.toBe('dashing');

    output = simulation.step(frame(tick + 1, { held: Action.Forward, pressed: Action.Jump }), TICK);
    expect(output.snapshot.player.locomotion).toBe('dashing');
    expect(output.snapshot.player.airCharge).toBe(0);
    simulation.dispose();
  });

  it('treats a press after the window as another jump, not a dash', async () => {
    const simulation = await start(level([FLOOR]));
    const start_ = settle(simulation);
    let output = simulation.step(frame(start_, { held: Action.Forward, pressed: Action.Jump }), TICK);
    const windowTicks = Math.ceil(movementProfile.dashDoubleTapSeconds / TICK) + 1;
    for (let tick = 1; tick <= windowTicks; tick += 1) output = simulation.step(frame(start_ + tick, { held: Action.Forward }), TICK);

    output = simulation.step(frame(start_ + windowTicks + 1, { held: Action.Forward, pressed: Action.Jump }), TICK);
    expect(output.snapshot.player.locomotion).not.toBe('dashing');
    expect(output.snapshot.player.airCharge).toBe(1);
    simulation.dispose();
  });

  it('alternates jump, dash, jump when the key is spammed', async () => {
    const simulation = await start(level([FLOOR]));
    const start_ = settle(simulation);
    const states: string[] = [];
    for (let tick = 0; tick < 12; tick += 1) {
      const output = simulation.step(frame(start_ + tick, { held: Action.Forward, pressed: tick % 2 === 0 ? Action.Jump : 0 }), TICK);
      if (tick % 2 === 0) states.push(output.snapshot.player.locomotion);
    }
    // Presses land every other tick, well inside the window, so they alternate.
    expect(states[0]).not.toBe('dashing');
    expect(states[1]).toBe('dashing');
    simulation.dispose();
  });
});

describe('wall jumping', () => {
  /** Hugs the wall on the ground, jumps off it, and waits out the coyote window. */
  async function approachWall(): Promise<{ simulation: FlowSimulation; tick: number }> {
    const simulation = await start(level([FLOOR, box('kick-wall', [-1.2, 4, 0], [1, 8, 30], 'wall-run')]));
    let tick = settle(simulation);
    for (let step = 0; step < 8; step += 1, tick += 1) simulation.step(frame(tick, { held: Action.Left | Action.Sprint }), TICK);
    simulation.step(frame(tick, { held: Action.Left | Action.Sprint, pressed: Action.Jump }), TICK);
    tick += 1;
    let output = simulation.step(frame(tick, { held: Action.Left | Action.Sprint }), TICK);
    tick += 1;
    while (!output.snapshot.player.wallJumpAvailable && tick < 80) {
      output = simulation.step(frame(tick, { held: Action.Left | Action.Sprint }), TICK);
      tick += 1;
    }
    expect(output.snapshot.entities[0].grounded).toBe(false);
    expect(output.snapshot.player.wallJumpAvailable).toBe(true);
    return { simulation, tick };
  }

  it('kicks off a wall-run surface while airborne', async () => {
    const { simulation, tick } = await approachWall();
    const output = simulation.step(frame(tick, { held: Action.Left | Action.Sprint, pressed: Action.Jump }), TICK);
    // The kick sends the player up and back along the wall normal.
    expect(output.snapshot.entities[0].velocity[1]).toBeCloseTo(movementProfile.wallJumpVertical - movementProfile.gravity * TICK, 2);
    expect(output.snapshot.entities[0].velocity[0]).toBeGreaterThan(0);
    simulation.dispose();
  });

  it('never lets the dash double-tap swallow an available wall jump', async () => {
    const { simulation, tick } = await approachWall();
    // Two presses on consecutive ticks would normally resolve to a dash.
    simulation.step(frame(tick, { held: Action.Left | Action.Sprint, pressed: Action.Jump }), TICK);
    const output = simulation.step(frame(tick + 1, { held: Action.Left | Action.Sprint, pressed: Action.Jump }), TICK);
    expect(output.snapshot.player.locomotion).not.toBe('dashing');
    expect(output.snapshot.player.airCharge).toBe(1);
    simulation.dispose();
  });
});

describe('ADS target lock', () => {
  const withGuard = () => level([FLOOR, box('back-wall', [0, 6, -40], [40, 12, 1])], {
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 },
      { id: 'guard', kind: 'bot-ranged', position: [1.6, 1, -10], rotationY: 0 },
    ],
  });

  /** Guard dead ahead, so the assist is at full strength. */
  const withCentredGuard = () => level([FLOOR, box('back-wall', [0, 6, -40], [40, 12, 1])], {
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 },
      { id: 'guard', kind: 'bot-ranged', position: [0, 1, -10], rotationY: 0 },
    ],
  });

  it('nudges toward a target it acquires without ever steering onto it', async () => {
    const simulation = await start(withGuard());
    let output = simulation.step(frame(1, { held: Action.Ads }), TICK);
    expect(output.snapshot.player.lockedTargetId).toBe(2);

    // Measured against how far the view itself travelled, not against error to the
    // guard: a ranged bot keeps repositioning, so error to it says as much about the
    // bot's movement as about the assist.
    const startYaw = output.snapshot.camera.yaw;
    const guard = output.snapshot.entities.find((entity) => entity.kind === 'bot')!;
    const bearing = Math.atan2(
      -(guard.position[0] - output.snapshot.camera.position[0]),
      -(guard.position[2] - output.snapshot.camera.position[2]),
    );
    const gap = bearing - startYaw;

    const ticks = 18;
    let widestStep = 0;
    let previousYaw = startYaw;
    for (let tick = 2; tick < 2 + ticks; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Ads }), TICK);
      widestStep = Math.max(widestStep, Math.abs(output.snapshot.camera.yaw - previousYaw));
      previousYaw = output.snapshot.camera.yaw;
    }
    const travelled = output.snapshot.camera.yaw - startYaw;

    // It moves, and it moves the right way.
    expect(Math.abs(travelled)).toBeGreaterThan(0);
    expect(Math.sign(travelled)).toBe(Math.sign(gap));
    // The old assist closed 37 per cent of the remaining angle every tick and was on
    // target inside five. A bounded rate cannot cover the gap in a third of a second,
    // so there is still aim left for the player to do.
    expect(Math.abs(travelled)).toBeLessThan(Math.abs(gap));
    expect(widestStep).toBeLessThanOrEqual(aimAssist.maxTurnRate * TICK + 1e-9);
    simulation.dispose();
  });

  it('damps the player own look rather than moving the crosshair for them', async () => {
    const look: readonly [number, number] = [140, 0];
    const turnWith = async (withTarget: boolean): Promise<number> => {
      const simulation = await start(withTarget ? withCentredGuard() : level([FLOOR]));
      const first = simulation.step(frame(1, { held: Action.Ads }), TICK);
      expect(first.snapshot.player.lockedTargetId).toBe(withTarget ? 2 : null);
      const before = first.snapshot.camera.yaw;
      const after = simulation.step(frame(2, { held: Action.Ads, look }), TICK).snapshot.camera.yaw;
      simulation.dispose();
      return Math.abs(after - before);
    };

    const damped = await turnWith(true);
    const free = await turnWith(false);
    expect(damped).toBeGreaterThan(0);
    // Slower on target, which is the whole assist, and still fully the player's turn.
    expect(damped).toBeLessThan(free);
    expect(damped).toBeGreaterThan(free * aimAssist.slowdownScale * 0.9);
  });

  it('stays manual when ADS is not held', async () => {
    const simulation = await start(withGuard());
    const output = simulation.step(frame(1), TICK);
    expect(output.snapshot.player.lockedTargetId).toBeNull();
    expect(output.snapshot.camera.yaw).toBe(0);
    simulation.dispose();
  });

  it('refuses targets hidden behind static geometry', async () => {
    const simulation = await start(level([FLOOR, box('blocker', [0, 3, -5], [12, 6, 1], 'no-traverse')], {
      spawns: [
        { id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 },
        { id: 'guard', kind: 'bot-ranged', position: [0, 1, -10], rotationY: 0 },
      ],
    }));
    const output = simulation.step(frame(1, { held: Action.Ads }), TICK);
    expect(output.snapshot.player.lockedTargetId).toBeNull();
    simulation.dispose();
  });

  it('drops targets that leave the hold cone', async () => {
    const simulation = await start(withGuard());
    let output = simulation.step(frame(1, { held: Action.Ads }), TICK);
    expect(output.snapshot.player.lockedTargetId).toBe(2);
    // Whip the view a long way past the hold cone in a single frame.
    output = simulation.step(frame(2, { held: Action.Ads, look: [Math.PI / 0.002, 0] }), TICK);
    expect(output.snapshot.player.lockedTargetId).toBeNull();
    simulation.dispose();
  });

  it('keeps the acquisition cone tighter than the cone that holds a lock', () => {
    expect(aimAssist.acquireCosine).toBeGreaterThan(aimAssist.holdCosine);
  });
});

describe('bot ledge safety', () => {
  /** A narrow platform floating over a void, with the player standing off its edge. */
  const ledgeLevel = (): LegacyLevelDocumentV1 => level([
    box('platform', [0, 4.5, -10], [10, 1, 10]),
  ], {
    spawns: [
      { id: 'player', kind: 'player', position: [0, 5.6, -10], rotationY: 0 },
      { id: 'guard', kind: 'bot-aggressive', position: [0, 5.6, -12], rotationY: 0 },
    ],
  });

  it('keeps unguided bots on their platform instead of chasing into the void', async () => {
    const simulation = await start(ledgeLevel());
    let output = simulation.step(frame(1), TICK);
    // Walk the player off the far edge so a naive chase would follow it down.
    for (let tick = 2; tick < 240; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Forward | Action.Sprint }), TICK);
      const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot');
      if (!bot) continue;
      expect(bot.position[1]).toBeGreaterThan(3);
      expect(Math.abs(bot.position[0])).toBeLessThan(8);
      expect(bot.position[2]).toBeGreaterThan(-18);
    }
    simulation.dispose();
  });

  it('holds the edge when an aggressive bot charges diagonally at it', async () => {
    // This is the case a step-scaled ledge probe missed: the bot closes fast and
    // off-axis, so the probe has to reach a fixed distance ahead of the capsule.
    const simulation = await start(level([
      box('platform', [0, 4.5, -10], [10, 1, 10]),
    ], {
      spawns: [
        { id: 'player', kind: 'player', position: [0, 5.6, -10], rotationY: 0 },
        { id: 'guard', kind: 'bot-aggressive', position: [0, 5.6, -12], rotationY: 0 },
      ],
    }));
    let output = simulation.step(frame(1), TICK);
    for (let tick = 2; tick < 200; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Forward | Action.Sprint }), TICK);
      const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot');
      if (!bot) continue;
      // The platform surface is y = 5; falling off drops it well below.
      expect(bot.position[1]).toBeGreaterThan(4.5);
    }
    simulation.dispose();
  });

  it('grounds authored bot spawns onto the surface beneath them', async () => {
    // Spawns authored against the old capsule sat slightly inside the floor.
    const simulation = await start(level([box('platform', [0, 4.5, -10], [10, 1, 10])], {
      spawns: [
        { id: 'player', kind: 'player', position: [0, 5.6, -10], rotationY: 0 },
        { id: 'guard', kind: 'bot-ranged', position: [0, 5.2, -12], rotationY: 0 },
      ],
    }));
    const output = simulation.step(frame(1), TICK);
    const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot')!;
    // Resting height puts the capsule bottom exactly on the surface at y = 5.
    expect(bot.position[1]).toBeCloseTo(5 + botColliderBottom, 2);
    simulation.dispose();
  });

  it('returns a bot to its spawn if it ever ends up in the void', async () => {
    const simulation = await start(level([FLOOR], {
      spawns: [
        { id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 },
        { id: 'guard', kind: 'bot-ranged', position: [0, -40, -6], rotationY: 0 },
      ],
    }));
    let output = simulation.step(frame(1), TICK);
    for (let tick = 2; tick < 10; tick += 1) output = simulation.step(frame(tick), TICK);
    const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot');
    expect(bot?.position[1]).toBeGreaterThan(-41);
    simulation.dispose();
  });
});

describe('bot damage persistence', () => {
  const arena = () => level([FLOOR], {
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 },
      { id: 'guard', kind: 'bot-ranged', position: [0, 1, -8], rotationY: 0 },
    ],
  });

  /** Fires with the ADS lock engaged until the predicate holds or the run times out. */
  async function fireUntil(simulation: FlowSimulation, done: (output: ReturnType<FlowSimulation['step']>) => boolean): Promise<ReturnType<FlowSimulation['step']>> {
    let output = simulation.step(frame(1, { held: Action.Ads }), TICK);
    for (let tick = 2; tick < 400; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Ads | Action.Fire, pressed: tick === 2 ? Action.Fire : 0 }), TICK);
      if (done(output)) return output;
    }
    return output;
  }

  it('keeps a killed bot dead through a checkpoint restore', async () => {
    const simulation = await start(arena());
    const killed = await fireUntil(simulation, (output) => output.events.some((event) => event.kind === 'kill'));
    expect(killed.events.some((event) => event.kind === 'kill')).toBe(true);

    simulation.restoreCheckpoint();
    const output = simulation.step(frame(400), TICK);
    expect(output.snapshot.entities.filter((entity) => entity.kind === 'bot')).toHaveLength(0);
    simulation.dispose();
  });

  it('keeps damage on a surviving bot through a checkpoint restore', async () => {
    const simulation = await start(arena());
    const wounded = await fireUntil(simulation, (output) => {
      const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot');
      return bot !== undefined && bot.health < 100;
    });
    const before = wounded.snapshot.entities.find((entity) => entity.kind === 'bot')!.health;
    expect(before).toBeLessThan(100);

    simulation.restoreCheckpoint();
    const output = simulation.step(frame(400), TICK);
    const after = output.snapshot.entities.find((entity) => entity.kind === 'bot');
    expect(after?.health).toBe(before);
    simulation.dispose();
  });

  it('refuses a bot well away from the crosshair', async () => {
    // Roughly 40 degrees off centre: on screen, but nowhere near the dot. The old cone
    // was a 45.8 degree half-angle, so this acquired and then got steered onto.
    const simulation = await start(level([FLOOR], {
      spawns: [
        { id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 },
        { id: 'guard', kind: 'bot-ranged', position: [10, 1, -8], rotationY: 0 },
      ],
    }));
    const output = simulation.step(frame(1, { held: Action.Ads }), TICK);
    expect(output.snapshot.player.lockedTargetId).toBeNull();
    simulation.dispose();
  });

  it('keeps the acquisition cone to something a player could be aiming at', () => {
    // Under about ten degrees of half-angle. Anything wider is not an assist.
    expect(Math.acos(aimAssist.acquireCosine)).toBeLessThan(0.18);
    expect(Math.acos(aimAssist.holdCosine)).toBeLessThan(0.31);
  });
});
