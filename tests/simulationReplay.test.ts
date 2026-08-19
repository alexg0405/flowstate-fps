import { describe, expect, it } from 'vitest';
import { Action, type InputFrame, type LevelDocumentV1 } from '../src/contracts';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const replayLevel: LevelDocumentV1 = {
  schemaVersion: 1,
  id: 'replay-course',
  name: 'Replay Course',
  units: 'meters',
  primitives: [{
    id: 'floor', kind: 'box', color: '#fff', collision: true, surface: 'default',
    transform: { position: [0, -0.5, -20], rotation: [0, 0, 0], scale: [30, 1, 60] },
  }],
  spawns: [{ id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 }],
  encounters: [],
  offMeshLinks: [],
  exit: [0, 1, -100],
};

describe('fixed input replay', () => {
  it('reproduces the same player trajectory', async () => {
    const frames = makeFrames(180);
    const first = await run(frames);
    const second = await run(frames);
    expect(first.length).toBe(second.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(first[index][0]).toBeCloseTo(second[index][0], 6);
      expect(first[index][1]).toBeCloseTo(second[index][1], 6);
      expect(first[index][2]).toBeCloseTo(second[index][2], 6);
    }
  });

  it('keeps encounter bots dormant until the player reaches their activation radius', async () => {
    const level = structuredClone(replayLevel);
    level.spawns.push({ id: 'guard', kind: 'bot-ranged', position: [0, 1, -8], rotationY: 0, encounterId: 'arena' });
    level.encounters.push({ id: 'arena', label: 'Arena', checkpoint: [0, 1, -80], requiredBotIds: ['guard'] });
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(level));
    let output = simulation.step({ tick: 1, held: 0, pressed: 0, released: 0, look: [0, 0] }, 1 / 60);
    expect(output.snapshot.entities.filter((entity) => entity.kind === 'bot')).toHaveLength(0);

    level.encounters[0].checkpoint = [0, 1, 0];
    await simulation.loadLevel(cookLevel(level));
    output = simulation.step({ tick: 1, held: 0, pressed: 0, released: 0, look: [0, 0] }, 1 / 60);
    expect(output.snapshot.entities.filter((entity) => entity.kind === 'bot')).toHaveLength(1);
    simulation.dispose();
  });

  it('opens authored gates when their encounter is cleared', async () => {
    const level = structuredClone(replayLevel);
    level.primitives.push({
      id: 'arena-gate', kind: 'box', color: '#f00', collision: true, surface: 'no-traverse', gateForEncounterId: 'arena',
      transform: { position: [0, 2, -12], rotation: [0, 0, 0], scale: [10, 4, 0.5] },
    });
    level.spawns.push({ id: 'guard', kind: 'bot-ranged', position: [0, 1, -3], rotationY: 0, encounterId: 'arena' });
    level.encounters.push({ id: 'arena', label: 'Arena', checkpoint: [0, 1, 0], requiredBotIds: ['guard'] });
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(level));
    let output = simulation.step({ tick: 1, held: 0, pressed: 0, released: 0, look: [0, 0] }, 1 / 60);
    for (let tick = 2; tick < 180 && !output.snapshot.openGateIds.includes('arena-gate'); tick += 1) {
      const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot');
      const camera = output.snapshot.camera;
      const dx = (bot?.position[0] ?? 0) - camera.position[0];
      const dy = (bot?.position[1] ?? 0) + 0.3 - camera.position[1];
      const dz = (bot?.position[2] ?? -3) - camera.position[2];
      const desiredYaw = Math.atan2(-dx, -dz);
      const desiredPitch = Math.atan2(dy, Math.hypot(dx, dz));
      output = simulation.step({
        tick,
        held: Action.Fire,
        pressed: tick === 2 ? Action.Fire : 0,
        released: 0,
        look: [(camera.yaw - desiredYaw) / 0.002, (camera.pitch - desiredPitch) / 0.002],
      }, 1 / 60);
    }
    expect(output.snapshot.openGateIds).toContain('arena-gate');
    expect(output.snapshot.openGateIds).toContain('arena');
    expect(output.snapshot.objective).toBe('Reach the finish gate');
    expect(output.events).toContainEqual(expect.objectContaining({ kind: 'gateOpen', gateId: 'arena-gate' }));
    simulation.dispose();
  });

  it('publishes deterministic motion, aim, ADS, action progress, and reload lifecycle telemetry', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(replayLevel));

    let output = simulation.step({
      tick: 1,
      held: Action.Fire | Action.Ads,
      pressed: Action.Fire,
      released: 0,
      look: [0, 0],
    }, 1 / 60);
    const playerEntity = output.snapshot.entities[0];
    expect(playerEntity.velocity).toHaveLength(3);
    expect(typeof playerEntity.grounded).toBe('boolean');
    expect(playerEntity.aimPitch).toBe(output.snapshot.camera.pitch);
    expect(output.snapshot.player.adsProgress).toBe(1);
    expect(output.snapshot.player.action).toBe('firing');
    expect(output.snapshot.player.actionProgress).toBe(0);

    output = simulation.step({ tick: 2, held: 0, pressed: Action.Reload, released: 0, look: [0, 0] }, 1 / 60);
    expect(output.events).toContainEqual(expect.objectContaining({ kind: 'reloadStart', sourceEntityId: playerEntity.id }));
    expect(output.snapshot.player.action).toBe('reloading');
    expect(output.snapshot.player.actionProgress).toBe(0);

    const lifecycle = [...output.events];
    for (let tick = 3; tick < 110; tick += 1) {
      output = simulation.step({ tick, held: 0, pressed: 0, released: 0, look: [0, 0] }, 1 / 60);
      lifecycle.push(...output.events);
      if (output.events.some((event) => event.kind === 'reloadComplete')) break;
      if (tick === 3) expect(output.snapshot.player.actionProgress).toBeGreaterThan(0);
    }
    expect(lifecycle).toContainEqual(expect.objectContaining({ kind: 'reloadComplete', sourceEntityId: playerEntity.id }));
    expect(output.snapshot.player.action).toBe('neutral');
    expect(output.snapshot.player.actionProgress).toBe(0);
    expect(output.snapshot.player.ammo).toBe(30);
    expect(output.snapshot.player.reserveAmmo).toBe(119);
    simulation.dispose();
  });

  it('enriches player impacts and bot attacks with stable combat attribution', async () => {
    const level = structuredClone(replayLevel);
    level.spawns.push({ id: 'guard', kind: 'bot-ranged', position: [0, 1, -3], rotationY: 0 });
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(level));

    let output = simulation.step({
      tick: 1,
      held: Action.Fire | Action.Ads,
      pressed: Action.Fire,
      released: 0,
      look: [0, -18],
    }, 1 / 60);
    const shot = output.events.find((event) => event.kind === 'shot');
    const impact = output.events.find((event) => event.kind === 'impact');
    const hit = output.events.find((event) => event.kind === 'hit' && event.targetEntityId === 2);
    // A shot is one trigger pull; per-target attribution lives on each impact,
    // because a multi-pellet weapon can strike several targets per shot.
    expect(shot).toMatchObject({ sourceEntityId: 1 });
    expect(impact).toMatchObject({ sourceEntityId: 1, targetEntityId: 2 });
    expect(impact?.normal).toHaveLength(3);
    expect(typeof impact?.headshot).toBe('boolean');
    expect(hit).toMatchObject({ entityId: 2, sourceEntityId: 1, targetEntityId: 2 });
    expect(hit?.normal).toHaveLength(3);
    expect(typeof hit?.headshot).toBe('boolean');

    const attackEvents = [];
    for (let tick = 2; tick < 120; tick += 1) {
      output = simulation.step({ tick, held: 0, pressed: 0, released: 0, look: [0, 0] }, 1 / 60);
      attackEvents.push(...output.events);
      if (output.events.some((event) => event.kind === 'enemyAttack')) break;
    }
    expect(attackEvents).toContainEqual(expect.objectContaining({
      kind: 'enemyAttack',
      entityId: 2,
      sourceEntityId: 2,
      targetEntityId: 1,
    }));
    expect(attackEvents).toContainEqual(expect.objectContaining({
      kind: 'hit',
      entityId: 1,
      sourceEntityId: 2,
      targetEntityId: 1,
      headshot: false,
    }));
    const botEntity = output.snapshot.entities.find((entity) => entity.kind === 'bot');
    expect(botEntity?.velocity).toHaveLength(3);
    expect(typeof botEntity?.grounded).toBe('boolean');
    expect(Number.isFinite(botEntity?.aimPitch)).toBe(true);
    simulation.dispose();
  });

  it('reports static impact normals and surface tags', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(replayLevel));
    const output = simulation.step({ tick: 1, held: Action.Fire, pressed: Action.Fire, released: 0, look: [0, 500] }, 1 / 60);
    expect(output.events).toContainEqual(expect.objectContaining({
      kind: 'impact',
      sourceEntityId: 1,
      surface: 'default',
      normal: expect.any(Array),
    }));
    simulation.dispose();
  });

  it('pulls the player toward the anchor and releases with a cooldown', async () => {
    const level = structuredClone(replayLevel);
    level.primitives.push({
      id: 'hook-wall', kind: 'box', color: '#0ff', collision: true, surface: 'default',
      transform: { position: [0, 4, -12], rotation: [0, 0, 0], scale: [12, 8, 1] },
    });
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(level));
    simulation.step({ tick: 1, held: 0, pressed: 0, released: 0, look: [0, 0] }, 1 / 60);
    let output = simulation.step({ tick: 2, held: Action.Grapple, pressed: Action.Grapple, released: 0, look: [0, 0] }, 1 / 60);
    expect(output.events.some((event) => event.kind === 'grappleAttach')).toBe(true);
    expect(output.snapshot.player.grapple.active).toBe(true);
    const initialDistance = output.snapshot.player.grapple.ropeLength;

    // The pull key drives movement; the tether alone does not move the player.
    for (let tick = 3; tick < 12; tick += 1) {
      output = simulation.step({
        tick,
        held: Action.Grapple | Action.GrapplePull,
        pressed: tick === 3 ? Action.GrapplePull : 0,
        released: 0,
        look: [0, 0],
      }, 1 / 60);
    }
    expect(output.snapshot.player.grapple.ropeLength).toBeLessThan(initialDistance);
    expect(output.snapshot.player.grapple.active).toBe(true);
    expect(output.snapshot.player.speed).toBeGreaterThan(0);

    output = simulation.step({ tick: 12, held: 0, pressed: 0, released: Action.Grapple, look: [0, 0] }, 1 / 60);
    expect(output.events.some((event) => event.kind === 'grappleRelease')).toBe(true);
    expect(output.snapshot.player.grapple.active).toBe(false);
    expect(output.snapshot.player.grapple.cooldown).toBeGreaterThan(0);
    simulation.dispose();
  });

  it('deterministically chains ground dash, jump cancel, and air dash', async () => {
    const frames: InputFrame[] = Array.from({ length: 50 }, (_, index) => ({
      tick: index + 1,
      held: Action.Forward | Action.Sprint,
      pressed: (index === 5 ? Action.Dash : 0) | (index === 8 ? Action.Jump : 0) | (index === 14 ? Action.Dash : 0),
      released: 0,
      look: [0, 0],
    }));
    const first = await run(frames);
    const second = await run(frames);
    expect(first).toEqual(second);
    expect(first.at(-1)![2]).toBeLessThan(first[0][2] - 6);
    expect(first.at(-1)![1]).toBeGreaterThan(1);
  });

  it('enforces the ground-dash cancel boundary and consumes the follow-up air charge', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(replayLevel));
    let output = simulation.step({ tick: 1, held: Action.Forward, pressed: Action.Dash | Action.Jump, released: 0, look: [0, 0] }, 1 / 60);
    expect(output.snapshot.player.locomotion).toBe('dashing');
    expect(output.snapshot.player.jumpCancelAvailable).toBe(false);
    const startY = output.snapshot.entities[0].position[1];
    output = simulation.step({ tick: 2, held: Action.Forward, pressed: 0, released: 0, look: [0, 0] }, 1 / 60);
    expect(output.snapshot.player.locomotion).toBe('dashing');
    expect(output.snapshot.player.jumpCancelAvailable).toBe(false);
    output = simulation.step({ tick: 3, held: Action.Forward, pressed: 0, released: 0, look: [0, 0] }, 1 / 60);
    expect(output.snapshot.entities[0].position[1]).toBeGreaterThan(startY);
    output = simulation.step({ tick: 4, held: Action.Forward, pressed: Action.Dash, released: 0, look: [0, 0] }, 1 / 60);
    expect(output.snapshot.player.locomotion).toBe('dashing');
    expect(output.snapshot.player.airCharge).toBe(0);
    simulation.dispose();
  });

  it('supports concurrent StrictMode-style initialization and idempotent disposal', async () => {
    const first = new FlowSimulation();
    const second = new FlowSimulation();
    await Promise.all([first.loadLevel(cookLevel(replayLevel)), second.loadLevel(cookLevel(replayLevel))]);
    expect(first.step({ tick: 1, held: 0, pressed: 0, released: 0, look: [0, 0] }, 1 / 60).snapshot.player.health).toBe(100);
    expect(second.step({ tick: 1, held: 0, pressed: 0, released: 0, look: [0, 0] }, 1 / 60).snapshot.player.health).toBe(100);
    expect(() => { first.dispose(); first.dispose(); second.dispose(); second.dispose(); }).not.toThrow();
  });

  it('fails cleanly when no grapple target is in range and detaches on suspend', async () => {
    const level = structuredClone(replayLevel);
    level.primitives.push({
      id: 'suspend-hook-wall', kind: 'box', color: '#0ff', collision: true, surface: 'default',
      transform: { position: [0, 4, -12], rotation: [0, 0, 0], scale: [12, 8, 1] },
    });
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(level));
    let output = simulation.step({ tick: 1, held: Action.Grapple, pressed: Action.Grapple, released: 0, look: [0, -10_000] }, 1 / 60);
    expect(output.events.some((event) => event.kind === 'grappleFail')).toBe(true);
    expect(output.snapshot.player.grapple.active).toBe(false);

    output = simulation.step({ tick: 2, held: Action.Grapple, pressed: Action.Grapple, released: 0, look: [0, 740] }, 1 / 60);
    expect(output.snapshot.player.grapple.active).toBe(true);
    expect(simulation.suspend().some((event) => event.kind === 'grappleRelease')).toBe(true);
    simulation.dispose();
  });
});

async function run(frames: InputFrame[]) {
  const simulation = new FlowSimulation();
  await simulation.loadLevel(cookLevel(replayLevel));
  const positions: (readonly [number, number, number])[] = [];
  for (const frame of frames) {
    const output = simulation.step(frame, 1 / 60);
    positions.push(output.snapshot.entities[0].position);
  }
  simulation.dispose();
  return positions;
}

function makeFrames(count: number): InputFrame[] {
  return Array.from({ length: count }, (_, index) => ({
    tick: index + 1,
    held: Action.Forward | (index < 110 ? Action.Sprint : 0),
    pressed: (index === 15 ? Action.Jump : 0) | (index === 55 ? Action.Dash : 0) | (index === 115 ? Action.Crouch : 0),
    released: 0,
    look: [index === 85 ? 18 : 0, 0] as const,
  }));
}
