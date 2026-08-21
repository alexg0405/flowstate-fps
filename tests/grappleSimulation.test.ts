import { describe, expect, it } from 'vitest';
import { Action, type InputFrame, type LegacyLevelDocumentV1, type LevelPrimitive, type Vec3 } from '../src/contracts';
import { movementProfile } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function box(id: string, position: Vec3, scale: Vec3, surface: LevelPrimitive['surface'] = 'default', gateForEncounterId?: string): LevelPrimitive {
  return {
    id,
    kind: 'box',
    transform: { position, rotation: [0, 0, 0], scale },
    color: '#8899aa',
    collision: true,
    surface,
    ...(gateForEncounterId ? { gateForEncounterId } : {}),
  };
}

const FLOOR = box('floor', [0, -0.5, -20], [40, 1, 80]);

function level(primitives: LevelPrimitive[], overrides: Partial<LegacyLevelDocumentV1> = {}): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'grapple-course',
    name: 'Grapple Course',
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
  // Every case in this file is about the gun, and the gun is a *selection* now rather
  // than the weapon the player starts a run holding. Drawing it costs a bit rather than
  // a frame: selection resolves at the top of `updateCombat`, before the trigger is read.
  const input: InputFrame = { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...patch };
  return { ...input, pressed: input.pressed | Action.SelectGunOne };
}

/** Look inputs are divided by the default 0.002 sensitivity inside the simulation. */
function pitchTo(radians: number): readonly [number, number] {
  return [0, -radians / 0.002];
}

describe('grapple targeting rules', () => {
  it('refuses anchors past the configured maximum range and accepts them inside it', async () => {
    const tooFar = await start(level([FLOOR, box('far-wall', [0, 6, -45], [30, 12, 1])]));
    const missed = tooFar.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(missed.events.some((event) => event.kind === 'grappleFail')).toBe(true);
    expect(missed.snapshot.player.grapple.active).toBe(false);
    tooFar.dispose();

    const inRange = await start(level([FLOOR, box('near-wall', [0, 6, -25], [30, 12, 1])]));
    const hit = inRange.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(hit.events.some((event) => event.kind === 'grappleAttach')).toBe(true);
    expect(hit.snapshot.player.grapple.ropeLength).toBeLessThan(movementProfile.grappleRange);
    expect(hit.snapshot.player.grapple.ropeLength).toBeGreaterThan(28);
    inRange.dispose();
  });

  it('passes through bots and attaches only to static level geometry', async () => {
    const simulation = await start(level([FLOOR, box('back-wall', [0, 6, -30], [30, 12, 1])], {
      spawns: [
        { id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 },
        { id: 'guard', kind: 'bot-ranged', position: [0, 1, -3], rotationY: 0 },
      ],
    }));
    const output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    const anchor = output.snapshot.player.grapple.anchor;
    expect(output.snapshot.player.grapple.active).toBe(true);
    // The bot sits 7 m ahead; the anchor has to land on the wall 34 m out instead.
    expect(anchor?.[2]).toBeLessThan(-28);
    simulation.dispose();
  });

  it('attaches while airborne rather than requiring a grounded state', async () => {
    const simulation = await start(level([FLOOR, box('hook-wall', [0, 6, -25], [30, 12, 1])]));
    simulation.step(frame(1, { pressed: Action.Jump }), TICK);
    let output = simulation.step(frame(2), TICK);
    for (let tick = 3; tick < 8; tick += 1) output = simulation.step(frame(tick), TICK);
    expect(output.snapshot.player.locomotion).toBe('airborne');
    output = simulation.step(frame(8, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(true);
    simulation.dispose();
  });
});

describe('minimum hook range', () => {
  /** A wall the player is standing a short distance from. */
  const closeWall = (playerZ: number) => level([FLOOR, box('wall', [0, 6, -20], [40, 12, 1])], {
    spawns: [{ id: 'player', kind: 'player', position: [0, 1, playerZ], rotationY: 0 }],
  });

  it('stays above the arrival radius, or a hook would release as it lands', () => {
    expect(movementProfile.grappleMinimumRange).toBeGreaterThan(movementProfile.grappleArrivalRadius);
  });

  it('refuses a surface that is already within arm’s reach', async () => {
    // The wall face sits 1.5 m ahead — inside the minimum.
    const simulation = await start(closeWall(-18));
    const output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(output.events.some((event) => event.kind === 'grappleFail')).toBe(true);
    expect(output.snapshot.player.grapple.active).toBe(false);
    // A refusal must not burn the cooldown, or the next real cast is dead too.
    expect(output.snapshot.player.grapple.cooldown).toBe(0);
    expect(output.snapshot.player.grapple.available).toBe(true);
    simulation.dispose();
  });

  it('leaves jump untouched when the hook was refused', async () => {
    const simulation = await start(closeWall(-18));
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(false);
    output = simulation.step(frame(2, { held: Action.Grapple, pressed: Action.Jump }), TICK);
    expect(output.snapshot.entities[0].velocity[1]).toBeGreaterThan(5);
    simulation.dispose();
  });

  it('attaches and survives the first tick beyond the minimum', async () => {
    const simulation = await start(closeWall(-14));
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(true);
    expect(output.snapshot.player.grapple.ropeLength).toBeGreaterThan(movementProfile.grappleMinimumRange);

    // Pulling into a wall should carry the player most of the way before release.
    for (let tick = 2; tick < 60; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Grapple | Action.GrapplePull, pressed: tick === 2 ? Action.GrapplePull : 0 }), TICK);
      if (!output.snapshot.player.grapple.active) break;
    }
    expect(output.snapshot.entities[0].position[2]).toBeLessThan(-18);
    simulation.dispose();
  });
});

describe('grapple detachment rules', () => {
  // Removing the anchored collider is also what exercises the line-of-sight
  // guard: a straight-line pull can never strafe behind cover on its own.
  it('detaches when the attached gate is removed by clearing its encounter', async () => {
    const simulation = await start(level([
      FLOOR,
      box('arena-gate', [0, 3, -14], [20, 6, 0.5], 'no-traverse', 'arena'),
    ], {
      spawns: [
        { id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 },
        { id: 'guard', kind: 'bot-ranged', position: [0, 1, -3], rotationY: 0, encounterId: 'arena' },
      ],
      encounters: [{ id: 'arena', label: 'Arena', checkpoint: [0, 1, 0], requiredBotIds: ['guard'] }],
    }));
    // The hook ray skips bots, so a level cast lands on the gate behind the guard.
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(true);

    let cleared = false;
    for (let tick = 2; tick < 240 && !cleared; tick += 1) {
      output = simulation.step(frame(tick, {
        held: Action.Grapple | Action.Attack,
        pressed: tick === 2 ? Action.Attack : 0,
        look: aimAt(output, [0, 0.3, 0]),
      }), TICK);
      cleared = output.snapshot.openGateIds.includes('arena-gate');
    }
    expect(cleared).toBe(true);
    expect(output.snapshot.player.grapple.active).toBe(false);
    simulation.dispose();
  });

  it('drops the rope on death and hands the hook back cleared on respawn', async () => {
    const simulation = await start(level([box('void-wall', [0, -18, -10], [20, 12, 1])], {
      spawns: [{ id: 'player', kind: 'player', position: [0, -20.5, 4], rotationY: 0 }],
    }));
    const death = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(death.events.some((event) => event.kind === 'death')).toBe(true);
    expect(death.events.some((event) => event.kind === 'grappleRelease')).toBe(true);
    expect(death.snapshot.player.grapple.active).toBe(false);
    expect(death.snapshot.player.awaitingRespawn).toBe(true);

    // Death is a state the player now leaves deliberately, and redeploying must not
    // hand back a hook still burning the release cooldown that death imposed.
    const respawn = simulation.step(frame(2, { pressed: Action.Jump }), TICK);
    expect(respawn.events.some((event) => event.kind === 'respawn')).toBe(true);
    expect(respawn.snapshot.player.grapple.cooldown).toBe(0);
    expect(respawn.snapshot.player.grapple.available).toBe(true);
    simulation.dispose();
  });

  it('restores checkpoints detached with the cooldown cleared', async () => {
    const simulation = await start(level([FLOOR, box('hook-wall', [0, 6, -25], [30, 12, 1])]));
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(true);
    simulation.restoreCheckpoint();
    output = simulation.step(frame(2, { held: Action.Grapple }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(false);
    expect(output.snapshot.player.grapple.cooldown).toBe(0);
    expect(output.snapshot.player.grapple.available).toBe(true);
    simulation.dispose();
  });

  it('blocks a re-cast until the release cooldown expires', async () => {
    const simulation = await start(level([FLOOR, box('hook-wall', [0, 6, -25], [30, 12, 1])]));
    simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    let output = simulation.step(frame(2, { released: Action.Grapple }), TICK);
    expect(output.snapshot.player.grapple.cooldown).toBeCloseTo(movementProfile.grappleCooldown, 5);

    output = simulation.step(frame(3, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(output.events.some((event) => event.kind === 'grappleFail')).toBe(true);
    expect(output.snapshot.player.grapple.active).toBe(false);

    for (let tick = 4; tick < 30; tick += 1) output = simulation.step(frame(tick), TICK);
    expect(output.snapshot.player.grapple.cooldown).toBe(0);
    output = simulation.step(frame(30, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(true);
    simulation.dispose();
  });
});

describe('linear pull with a boost', () => {
  const overhead = () => level([FLOOR, box('overhead', [0, 20, -22], [16, 2, 16], 'no-traverse')]);

  /** Perpendicular distance from the attach-to-anchor segment. */
  function offsetFromLine(from: readonly [number, number, number], to: Vec3, point: readonly [number, number, number]): number {
    const ax = to[0] - from[0];
    const ay = to[1] - from[1];
    const az = to[2] - from[2];
    const length = Math.hypot(ax, ay, az) || 1;
    const px = point[0] - from[0];
    const py = point[1] - from[1];
    const pz = point[2] - from[2];
    const along = (px * ax + py * ay + pz * az) / length;
    return Math.hypot(px - (ax / length) * along, py - (ay / length) * along, pz - (az / length) * along);
  }

  it('travels the aimed line at a constant speed with no presses at all', async () => {
    const simulation = await start(overhead());
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple, look: pitchTo(0.55) }), TICK);
    const anchor = output.snapshot.player.grapple.anchor!;
    const origin = output.snapshot.entities[0].position;

    for (let tick = 2; tick < 26; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Grapple }), TICK);
      if (!output.snapshot.player.grapple.active) break;
      const entity = output.snapshot.entities[0];
      expect(Math.hypot(...entity.velocity)).toBeCloseTo(movementProfile.grapplePullSpeed, 3);
      expect(offsetFromLine(origin, anchor, entity.position)).toBeLessThan(0.05);
    }
    simulation.dispose();
  });

  it('ignores movement input so the path stays exactly the aimed line', async () => {
    const travel = async (extra: number) => {
      const simulation = await start(overhead());
      let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple, look: pitchTo(0.55) }), TICK);
      for (let tick = 2; tick < 20; tick += 1) output = simulation.step(frame(tick, { held: Action.Grapple | extra }), TICK);
      simulation.dispose();
      return output.snapshot.entities[0].position;
    };
    expect(await travel(Action.Right | Action.Forward)).toEqual(await travel(0));
  });

  it('accelerates the travel on each pull press', async () => {
    const simulation = await start(overhead());
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple, look: pitchTo(0.55) }), TICK);
    output = simulation.step(frame(2, { held: Action.Grapple }), TICK);
    const base = Math.hypot(...output.snapshot.entities[0].velocity);
    expect(base).toBeCloseTo(movementProfile.grapplePullSpeed, 3);

    output = simulation.step(frame(3, { held: Action.Grapple | Action.GrapplePull, pressed: Action.GrapplePull }), TICK);
    expect(output.events.some((event) => event.kind === 'grapplePull')).toBe(true);
    const boosted = Math.hypot(...output.snapshot.entities[0].velocity);
    expect(boosted).toBeCloseTo(movementProfile.grapplePullSpeed + movementProfile.grapplePullImpulse, 3);

    // The added speed persists for the rest of the tether rather than decaying.
    output = simulation.step(frame(4, { held: Action.Grapple }), TICK);
    expect(Math.hypot(...output.snapshot.entities[0].velocity)).toBeCloseTo(boosted, 3);
    simulation.dispose();
  });

  it('rate limits presses and caps the speed they can reach', async () => {
    const simulation = await start(overhead());
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple, look: pitchTo(0.55) }), TICK);
    let pulls = 0;
    for (let tick = 2; tick < 60; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Grapple | Action.GrapplePull, pressed: Action.GrapplePull }), TICK);
      pulls += output.events.filter((event) => event.kind === 'grapplePull').length;
      if (!output.snapshot.player.grapple.active) break;
      expect(Math.hypot(...output.snapshot.entities[0].velocity)).toBeLessThanOrEqual(movementProfile.grappleMaxSpeed + 1e-6);
    }
    // A press every tick must not resolve to a pull every tick.
    expect(pulls).toBeLessThanOrEqual(Math.ceil((58 * TICK) / movementProfile.grapplePullCooldown) + 1);
    expect(pulls).toBeGreaterThan(1);
    simulation.dispose();
  });

  it('releases on arrival and hands the momentum back', async () => {
    const simulation = await start(level([FLOOR, box('overhead', [0, 26, 0], [20, 2, 20], 'no-traverse')]));
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple, look: pitchTo(1.4) }), TICK);
    let released = false;
    for (let tick = 2; tick < 300 && !released; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Grapple }), TICK);
      released = output.events.some((event) => event.kind === 'grappleRelease');
    }
    expect(released).toBe(true);
    expect(output.snapshot.entities[0].velocity[1]).toBeGreaterThan(movementProfile.grapplePullSpeed * 0.5);
    simulation.dispose();
  });

  it('leaves the pull key free of jump and dash', async () => {
    const simulation = await start(overhead());
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple, look: pitchTo(0.55) }), TICK);
    // Pull presses at the natural cadence never register as a dash.
    for (let tick = 2; tick < 40; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Grapple | Action.GrapplePull, pressed: tick % 11 === 0 ? Action.GrapplePull : 0 }), TICK);
      if (!output.snapshot.player.grapple.active) break;
      expect(output.snapshot.player.locomotion).not.toBe('dashing');
    }
    expect(output.snapshot.player.airCharge).toBe(1);
    simulation.dispose();
  });

  it('suppresses jump while hooked but keeps the dash escape', async () => {
    const simulation = await start(overhead());
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple, look: pitchTo(0.55) }), TICK);
    // A jump cannot fight the rail, so the tether survives and the line holds.
    output = simulation.step(frame(2, { held: Action.Grapple, pressed: Action.Jump }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(true);
    expect(Math.hypot(...output.snapshot.entities[0].velocity)).toBeCloseTo(movementProfile.grapplePullSpeed, 3);

    output = simulation.step(frame(3, { held: Action.Grapple | Action.Forward, pressed: Action.Dash }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(false);
    expect(output.snapshot.player.locomotion).toBe('dashing');
    simulation.dispose();
  });

  it('gives up rather than hanging when geometry blocks the line', async () => {
    const simulation = await start(level([FLOOR, box('blocker', [0, 4, -10], [20, 8, 1], 'no-traverse')]));
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple }), TICK);
    expect(output.snapshot.player.grapple.active).toBe(true);
    let released = false;
    for (let tick = 2; tick < 200 && !released; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Grapple }), TICK);
      released = output.events.some((event) => event.kind === 'grappleRelease');
    }
    expect(released).toBe(true);
    simulation.dispose();
  });

  it('reports the shrinking distance to the anchor', async () => {
    const simulation = await start(overhead());
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple, look: pitchTo(0.55) }), TICK);
    let previous = output.snapshot.player.grapple.ropeLength;
    for (let tick = 2; tick < 14; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Grapple }), TICK);
      const current = output.snapshot.player.grapple.ropeLength;
      expect(current).toBeLessThan(previous);
      previous = current;
    }
    simulation.dispose();
  });
});

describe('grapple chain integrity', () => {
  it('recharges the air dash on a new wall after the charge is spent mid-air', async () => {
    const simulation = await start(level([FLOOR, box('run-wall', [0, 3, -2], [20, 7, 1], 'wall-run')]));
    let output = simulation.step(frame(1, { held: Action.Forward | Action.Sprint, pressed: Action.Jump }), TICK);
    output = simulation.step(frame(2, { held: Action.Forward | Action.Sprint, pressed: Action.Dash }), TICK);
    expect(output.snapshot.player.airCharge).toBe(0);

    let recharged = false;
    for (let tick = 3; tick < 90 && !recharged; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Forward | Action.Sprint }), TICK);
      recharged = output.snapshot.player.airCharge === 1 && !output.snapshot.entities[0].grounded;
    }
    expect(recharged).toBe(true);
    simulation.dispose();
  });

  it('produces identical trajectories for identical recorded grapple input', async () => {
    const frames: InputFrame[] = Array.from({ length: 90 }, (_, index) => frame(index + 1, {
      held: (index >= 1 ? Action.Grapple : 0) | (index > 20 ? Action.Right : 0) | (index > 45 ? Action.Forward : 0),
      pressed: (index === 1 ? Action.Grapple : 0) | (index === 30 ? Action.Dash : 0) | (index === 60 ? Action.Jump : 0),
      released: index === 80 ? Action.Grapple : 0,
      look: index === 1 ? pitchTo(0.6) : [0, 0],
    }));
    const [first, second] = await Promise.all([replay(frames), replay(frames)]);
    expect(first).toEqual(second);
  });

  it('never emits non-finite state or tunnels through the floor at high speed', async () => {
    const simulation = await start(level([FLOOR, box('overhead', [0, 18, -22], [16, 2, 16], 'no-traverse')]));
    let output = simulation.step(frame(1, { held: Action.Grapple, pressed: Action.Grapple, look: pitchTo(0.45) }), TICK);
    for (let tick = 2; tick < 240; tick += 1) {
      output = simulation.step(frame(tick, {
        held: Action.Grapple | Action.Forward | Action.Sprint,
        pressed: tick % 20 === 0 ? Action.Dash : 0,
      }), TICK);
      const [x, y, z] = output.snapshot.entities[0].position;
      const velocity = output.snapshot.entities[0].velocity;
      expect([x, y, z, ...velocity, output.snapshot.player.grapple.ropeLength].every(Number.isFinite)).toBe(true);
      // The floor surface sits at y = 0; the capsule centre may never sink below it.
      expect(y).toBeGreaterThan(-0.5);
      expect(Math.hypot(x, z)).toBeLessThan(200);
    }
    simulation.dispose();
  });
});

async function replay(frames: readonly InputFrame[]): Promise<number[][]> {
  const simulation = await start(level([FLOOR, box('overhead', [0, 16, -14], [12, 2, 12], 'no-traverse')]));
  const trace: number[][] = [];
  for (const input of frames) {
    const output = simulation.step(input, TICK);
    trace.push([...output.snapshot.entities[0].position, output.snapshot.player.grapple.ropeLength]);
  }
  simulation.dispose();
  return trace;
}

/** Converts the current bot position into the raw look delta that centres it. */
function aimAt(output: { snapshot: { camera: { position: readonly [number, number, number]; yaw: number; pitch: number }; entities: readonly { kind: string; position: readonly [number, number, number] }[] } }, offset: Vec3): readonly [number, number] {
  const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot');
  if (!bot) return [0, 0];
  const camera = output.snapshot.camera;
  const dx = bot.position[0] + offset[0] - camera.position[0];
  const dy = bot.position[1] + offset[1] - camera.position[1];
  const dz = bot.position[2] + offset[2] - camera.position[2];
  const desiredYaw = Math.atan2(-dx, -dz);
  const desiredPitch = Math.atan2(dy, Math.hypot(dx, dz));
  return [(camera.yaw - desiredYaw) / 0.002, (camera.pitch - desiredPitch) / 0.002];
}

function magnitude(vector: readonly [number, number, number]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}
