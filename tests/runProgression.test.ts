import { describe, expect, it } from 'vitest';
import { Action, type InputFrame, type LegacyLevelDocumentV1, type SimulationOutput } from '../src/contracts';
import { playerHealth, runScoring } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

/** Spawns the player already below the void plane, so death lands on the first tick. */
function voidLevel(): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'void-drop',
    name: 'Void Drop',
    units: 'meters',
    primitives: [{
      id: 'far-wall', kind: 'box', color: '#333', collision: true, surface: 'default',
      transform: { position: [0, -40, -30], rotation: [0, 0, 0], scale: [10, 2, 1] },
    }],
    spawns: [{ id: 'player', kind: 'player', position: [0, -20.5, 0], rotationY: 0 }],
    encounters: [],
    offMeshLinks: [],
    exit: [0, -20, -100],
  };
}

/** A small pad over open space, so the player can be walked off the edge. */
function ledgeLevel(): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'ledge',
    name: 'Ledge',
    units: 'meters',
    primitives: [{
      id: 'pad', kind: 'box', color: '#fff', collision: true, surface: 'default',
      transform: { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [6, 1, 6] },
    }],
    spawns: [{ id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 }],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -100],
  };
}

/** Flat arena with one guard gating an encounter, so a split can actually be earned. */
function encounterLevel(): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'split-course',
    name: 'Split Course',
    units: 'meters',
    primitives: [{
      id: 'floor', kind: 'box', color: '#fff', collision: true, surface: 'default',
      transform: { position: [0, -0.5, -20], rotation: [0, 0, 0], scale: [40, 1, 80] },
    }],
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 },
      { id: 'guard', kind: 'bot-ranged', position: [0, 1, -6], rotationY: 0, encounterId: 'arena' },
    ],
    encounters: [{ id: 'arena', label: 'Atrium', checkpoint: [0, 1, 0], requiredBotIds: ['guard'] }],
    offMeshLinks: [],
    exit: [0, 1, -200],
  };
}

/** Drives fire while steering the view onto the first live bot, as the replay tests do. */
function huntBot(simulation: FlowSimulation, ticks: number, done: (output: SimulationOutput) => boolean): SimulationOutput {
  let output = simulation.step(frame(1), TICK);
  for (let tick = 2; tick < ticks && !done(output); tick += 1) {
    const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot');
    const camera = output.snapshot.camera;
    const dx = (bot?.position[0] ?? 0) - camera.position[0];
    const dy = (bot?.position[1] ?? 0) + 0.3 - camera.position[1];
    const dz = (bot?.position[2] ?? -6) - camera.position[2];
    output = simulation.step(frame(tick, {
      held: Action.Fire,
      pressed: tick === 2 ? Action.Fire : 0,
      look: [
        (camera.yaw - Math.atan2(-dx, -dz)) / 0.002,
        (camera.pitch - Math.atan2(dy, Math.hypot(dx, dz))) / 0.002,
      ],
    }), TICK);
  }
  return output;
}

describe('death is a state the player leaves', () => {
  it('goes down and waits instead of teleporting silently', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(voidLevel()));

    const death = simulation.step(frame(1), TICK);
    expect(death.events.some((event) => event.kind === 'death')).toBe(true);
    expect(death.snapshot.player.awaitingRespawn).toBe(true);
    expect(death.snapshot.player.locomotion).toBe('dead');
    expect(death.snapshot.player.health).toBe(0);
    expect(death.snapshot.player.deaths).toBe(1);

    // Death used to restore the checkpoint on the same tick, so the player was never
    // actually dead and there was nothing to present.
    const waiting = simulation.step(frame(2, { held: Action.Forward }), TICK);
    expect(waiting.snapshot.player.awaitingRespawn).toBe(true);
    expect(waiting.events).toHaveLength(0);
    simulation.dispose();
  });

  it('freezes the clock while down, so the death panel cannot ruin a run', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(voidLevel()));
    const death = simulation.step(frame(1), TICK);
    const frozen = death.snapshot.elapsedSeconds;

    let output = death;
    for (let tick = 2; tick <= 120; tick += 1) output = simulation.step(frame(tick), TICK);
    expect(output.snapshot.elapsedSeconds).toBe(frozen);
    expect(output.snapshot.player.awaitingRespawn).toBe(true);
    simulation.dispose();
  });

  it('charges the death penalty once, up front', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(voidLevel()));
    const alive = simulation.step(frame(1), TICK).snapshot.elapsedSeconds;
    // The tick that kills also advances the clock normally, so the penalty is the
    // difference beyond that one step.
    expect(alive).toBeCloseTo(TICK + runScoring.deathTimePenaltySeconds, 5);
    simulation.dispose();
  });

  it('redeploys on a press and comes back at full strength', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(voidLevel()));
    simulation.step(frame(1), TICK);

    const respawn = simulation.step(frame(2, { pressed: Action.Jump }), TICK);
    expect(respawn.events.some((event) => event.kind === 'respawn')).toBe(true);
    expect(respawn.snapshot.player.awaitingRespawn).toBe(false);
    expect(respawn.snapshot.player.health).toBe(playerHealth);
    simulation.dispose();
  });

  it('also accepts fire as the redeploy input', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(voidLevel()));
    simulation.step(frame(1), TICK);
    const respawn = simulation.step(frame(2, { pressed: Action.Fire }), TICK);
    expect(respawn.snapshot.player.awaitingRespawn).toBe(false);
    simulation.dispose();
  });

  it('counts every death across respawns and charges each one', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(voidLevel()));

    // The checkpoint is the void spawn itself, so each redeploy dies again.
    let output = simulation.step(frame(1), TICK);
    for (let round = 0; round < 2; round += 1) {
      output = simulation.step(frame(2 + round * 2, { pressed: Action.Jump }), TICK);
      output = simulation.step(frame(3 + round * 2), TICK);
    }
    expect(output.snapshot.player.deaths).toBe(3);
    // Three deaths, three penalties, and none of the frozen ticks in between.
    expect(output.snapshot.elapsedSeconds).toBeGreaterThanOrEqual(3 * runScoring.deathTimePenaltySeconds);
    simulation.dispose();
  });

  it('kills a fall off the level and keeps the count through a checkpoint restore', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(ledgeLevel()));

    // Walk off the pad and fall past the void plane.
    let output = simulation.step(frame(1), TICK);
    let tick = 2;
    for (; tick <= 300 && !output.snapshot.player.awaitingRespawn; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Forward | Action.Sprint }), TICK);
    }
    expect(output.snapshot.player.awaitingRespawn).toBe(true);
    expect(output.snapshot.player.deaths).toBe(1);

    const respawned = simulation.step(frame(tick += 1, { pressed: Action.Jump }), TICK);
    expect(respawned.snapshot.player.deaths).toBe(1);
    // Deaths are a run statistic, not checkpoint state: restoring must not launder them.
    simulation.restoreCheckpoint();
    const after = simulation.step(frame(tick + 1), TICK);
    expect(after.snapshot.player.deaths).toBe(1);
    expect(after.snapshot.player.awaitingRespawn).toBe(false);
    simulation.dispose();
  });
});

describe('checkpoint splits', () => {
  it('records the clock at each cleared encounter and announces it', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(encounterLevel()));
    const output = huntBot(simulation, 400, (current) => current.snapshot.splits.length > 0);

    expect(output.snapshot.splits).toHaveLength(1);
    const [split] = output.snapshot.splits;
    expect(split).toMatchObject({ encounterId: 'arena', label: 'Atrium' });
    expect(split.seconds).toBeGreaterThan(0);
    expect(split.seconds).toBeCloseTo(output.snapshot.elapsedSeconds, 5);
    simulation.dispose();
  });

  it('survives a checkpoint restore, since the encounter is still cleared', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(encounterLevel()));
    const cleared = huntBot(simulation, 400, (current) => current.snapshot.splits.length > 0);
    const recorded = cleared.snapshot.splits[0];

    simulation.restoreCheckpoint();
    const after = simulation.step(frame(500), TICK);
    expect(after.snapshot.splits).toEqual([recorded]);
    simulation.dispose();
  });

  it('starts a fresh run with no splits and no deaths', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(encounterLevel()));
    huntBot(simulation, 400, (current) => current.snapshot.splits.length > 0);

    // Reloading is what starts a new attempt, so run statistics reset with it.
    await simulation.loadLevel(cookLevel(encounterLevel()));
    const fresh = simulation.step(frame(1), TICK);
    expect(fresh.snapshot.splits).toEqual([]);
    expect(fresh.snapshot.player.deaths).toBe(0);
    simulation.dispose();
  });
});
