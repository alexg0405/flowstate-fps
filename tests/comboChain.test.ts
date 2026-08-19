import { describe, expect, it } from 'vitest';
import { Action, type GameEvent, type InputFrame, type LegacyLevelDocumentV1 } from '../src/contracts';
import { comboScoring } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

/** Long floor with wall-run walls down both sides and a hookable wall straight ahead. */
function course(): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'combo-course',
    name: 'Combo Course',
    units: 'meters',
    primitives: [
      {
        id: 'floor', kind: 'box', color: '#fff', collision: true, surface: 'default',
        transform: { position: [0, -0.5, -20], rotation: [0, 0, 0], scale: [12, 1, 80] },
      },
      {
        id: 'left-wall', kind: 'box', color: '#0ff', collision: true, surface: 'wall-run',
        transform: { position: [-6, 3, -20], rotation: [0, 0, 0], scale: [1, 7, 80] },
      },
      {
        id: 'right-wall', kind: 'box', color: '#0ff', collision: true, surface: 'wall-run',
        transform: { position: [6, 3, -20], rotation: [0, 0, 0], scale: [1, 7, 80] },
      },
      {
        id: 'hook-wall', kind: 'box', color: '#f0f', collision: true, surface: 'no-traverse',
        transform: { position: [0, 4, -20], rotation: [0, 0, 0], scale: [12, 9, 1] },
      },
    ],
    spawns: [{ id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 }],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -200],
  };
}

/** Jump, then double-tap into an air dash: the canonical opening of a chain. */
function airDash(simulation: FlowSimulation, startTick: number): GameEvent[] {
  const events: GameEvent[] = [];
  events.push(...simulation.step(frame(startTick, { pressed: Action.Jump, held: Action.Jump | Action.Forward }), TICK).events);
  events.push(...simulation.step(frame(startTick + 1, { held: Action.Forward }), TICK).events);
  events.push(...simulation.step(frame(startTick + 2, { pressed: Action.Jump, held: Action.Jump | Action.Forward }), TICK).events);
  return events;
}

describe('the flow chain', () => {
  it('links an air dash and raises the multiplier', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(course()));
    // Settle on the floor first, so the opening press is a grounded jump.
    for (let tick = 1; tick <= 20; tick += 1) simulation.step(frame(tick), TICK);

    const events = airDash(simulation, 21);
    const link = events.find((event) => event.kind === 'comboLink');
    expect(link).toBeDefined();
    expect(link?.value).toBe(1);

    const after = simulation.step(frame(30, { held: Action.Forward }), TICK).snapshot.player.combo;
    expect(after.links).toBe(1);
    expect(after.multiplier).toBeCloseTo(1 + comboScoring.linkStep, 5);
    expect(after.peakLinks).toBe(1);
    expect(after.window).toBeGreaterThan(0);
    simulation.dispose();
  });

  it('cannot be farmed by repeating one tech on a flat floor', async () => {
    // Away from the walls, so the air dash is the only tech available.
    const flat = course();
    flat.primitives = [flat.primitives[0]];
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(flat));
    for (let tick = 1; tick <= 30; tick += 1) simulation.step(frame(tick), TICK);
    const before = simulation.step(frame(31), TICK).snapshot.player.score;

    // Jump, air dash, land to recharge, repeat -- the cycle that made the air-charge
    // economy an insufficient defence on its own.
    let dashes = 0;
    let peak = 0;
    let output = simulation.step(frame(32), TICK);
    for (let tick = 33; tick <= 700; tick += 1) {
      const phase = tick % 45;
      output = simulation.step(frame(tick, {
        held: phase < 2 || (phase >= 6 && phase < 8) ? Action.Jump : 0,
        pressed: phase === 0 || phase === 6 ? Action.Jump : 0,
      }), TICK);
      if (output.snapshot.player.locomotion === 'dashing') dashes += 1;
      peak = Math.max(peak, output.snapshot.player.combo.links);
    }
    expect(dashes).toBeGreaterThan(60);
    // The dash links once per chain, and a chain of one pays nothing.
    expect(peak).toBe(1);
    expect(output.snapshot.player.score).toBe(before);
    simulation.dispose();
  });

  it('pays nothing for an isolated link and pays from the second', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(course()));
    for (let tick = 1; tick <= 20; tick += 1) simulation.step(frame(tick), TICK);
    const before = simulation.step(frame(21), TICK).snapshot.player.score;

    airDash(simulation, 22);
    const single = simulation.step(frame(26), TICK).snapshot;
    expect(single.player.combo.links).toBe(1);
    expect(single.player.score).toBe(before);

    // A second, different tech turns it into a chain, and that is what scores.
    const chained = simulation.step(frame(27, { pressed: Action.Grapple, held: Action.Grapple }), TICK).snapshot;
    expect(chained.player.combo.links).toBe(2);
    expect(chained.player.score - before).toBe(Math.round(comboScoring.linkScore * 1.2));
    simulation.dispose();
  });

  it('refuses a second link from the same tech inside one chain', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(course()));
    for (let tick = 1; tick <= 20; tick += 1) simulation.step(frame(tick), TICK);

    // Hook, then hook again inside the same chain: growing a chain has to mean
    // reaching for a different tool.
    let output = simulation.step(frame(21, { pressed: Action.Grapple, held: Action.Grapple }), TICK);
    expect(output.snapshot.player.combo.links).toBe(1);
    output = simulation.step(frame(22, { released: Action.Grapple }), TICK);
    for (let tick = 23; tick <= 60; tick += 1) {
      output = simulation.step(frame(tick, {
        held: tick > 45 ? Action.Grapple : 0,
        pressed: tick === 46 ? Action.Grapple : 0,
      }), TICK);
    }
    expect(output.snapshot.player.combo.links).toBe(1);
    simulation.dispose();
  });

  it('lapses when nothing extends it inside the window', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(course()));
    for (let tick = 1; tick <= 20; tick += 1) simulation.step(frame(tick), TICK);
    airDash(simulation, 21);

    let broke: GameEvent | undefined;
    let tick = 24;
    const deadline = tick + Math.ceil(comboScoring.linkWindowSeconds * 60) + 30;
    for (; tick <= deadline && !broke; tick += 1) {
      broke = simulation.step(frame(tick), TICK).events.find((event) => event.kind === 'comboBreak');
    }
    expect(broke).toBeDefined();
    expect(broke?.value).toBe(1);

    const after = simulation.step(frame(tick + 1), TICK).snapshot.player.combo;
    expect(after.links).toBe(0);
    expect(after.multiplier).toBe(1);
    // The peak is a run statistic, so a broken chain does not erase what was reached.
    expect(after.peakLinks).toBe(1);
    simulation.dispose();
  });

  it('keeps the chain alive while links keep arriving', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(course()));
    for (let tick = 1; tick <= 20; tick += 1) simulation.step(frame(tick), TICK);

    // Hook the wall ahead: the attach links, and the first pull links again.
    let output = simulation.step(frame(21, { pressed: Action.Grapple, held: Action.Grapple }), TICK);
    expect(output.events.some((event) => event.kind === 'grappleAttach')).toBe(true);
    expect(output.events.some((event) => event.kind === 'comboLink')).toBe(true);

    let pulls = 0;
    for (let tick = 22; tick <= 60; tick += 1) {
      output = simulation.step(frame(tick, {
        held: Action.Grapple | Action.GrapplePull,
        pressed: tick % 12 === 0 ? Action.GrapplePull : 0,
      }), TICK);
      pulls += output.events.filter((event) => event.kind === 'grapplePull').length;
      if (!output.snapshot.player.grapple.active) break;
    }
    expect(pulls).toBeGreaterThan(0);
    expect(output.snapshot.player.combo.links).toBeGreaterThan(1);
    simulation.dispose();
  });

  it('breaks the chain on death and does not link while down', async () => {
    const level = course();
    // A pad over open space, so the player can be walked off the edge.
    level.primitives = [level.primitives[0]];
    level.primitives[0] = {
      ...level.primitives[0],
      transform: { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [6, 1, 6] },
    };
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(level));
    for (let tick = 1; tick <= 20; tick += 1) simulation.step(frame(tick), TICK);
    airDash(simulation, 21);

    let output = simulation.step(frame(24, { held: Action.Forward | Action.Sprint }), TICK);
    let tick = 25;
    for (; tick <= 400 && !output.snapshot.player.awaitingRespawn; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Forward | Action.Sprint }), TICK);
    }
    expect(output.snapshot.player.awaitingRespawn).toBe(true);
    expect(output.snapshot.player.combo.links).toBe(0);

    // While down, the redeploy press must not be read as chainable tech.
    const respawn = simulation.step(frame(tick + 1, { pressed: Action.Jump }), TICK);
    expect(respawn.events.some((event) => event.kind === 'comboLink')).toBe(false);
    expect(respawn.snapshot.player.combo.links).toBe(0);
    simulation.dispose();
  });

  it('caps the multiplier so a long chain cannot run away', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(course()));
    for (let tick = 1; tick <= 20; tick += 1) simulation.step(frame(tick), TICK);

    // Reach into the internals rather than performing twenty perfect links: the cap
    // is the property under test, not the route needed to get there.
    const player = (simulation as unknown as { player: { comboLinks: number; comboTimer: number } }).player;
    player.comboLinks = comboScoring.maxLinks + 50;
    player.comboTimer = comboScoring.linkWindowSeconds;
    const combo = simulation.step(frame(21), TICK).snapshot.player.combo;
    expect(combo.multiplier).toBeCloseTo(1 + comboScoring.maxLinks * comboScoring.linkStep, 5);
    simulation.dispose();
  });

  it('reproduces the same chain for the same recorded input', async () => {
    const run = async (): Promise<number[]> => {
      const simulation = new FlowSimulation();
      await simulation.loadLevel(cookLevel(course()));
      const links: number[] = [];
      for (let tick = 1; tick <= 200; tick += 1) {
        const output = simulation.step(frame(tick, {
          held: Action.Forward | (tick % 30 < 2 ? Action.Jump : 0),
          pressed: tick % 30 === 0 || tick % 30 === 4 ? Action.Jump : 0,
        }), TICK);
        links.push(output.snapshot.player.combo.links);
      }
      simulation.dispose();
      return links;
    };
    expect(await run()).toEqual(await run());
  });
});
