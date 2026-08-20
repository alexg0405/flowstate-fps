import { describe, expect, it } from 'vitest';
import { Action, type GameEvent, type InputFrame, type LegacyLevelDocumentV1, type SimulationSnapshot, type SpawnDefinition } from '../src/contracts';
import { botProfiles, rifle } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

/**
 * Flat arena. The player spawns facing -Z, so a bot placed ahead of them is in the
 * line of a shot fired on the very first tick, before anything has turned.
 */
function arena(guard: SpawnDefinition): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'bulwark',
    name: 'Bulwark',
    units: 'meters',
    primitives: [{
      id: 'floor', kind: 'box', color: '#fff', collision: true, surface: 'default',
      transform: { position: [0, -0.5, -20], rotation: [0, 0, 0], scale: [40, 1, 80] },
    }],
    spawns: [{ id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 }, guard],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -200],
  };
}

const idle: Omit<InputFrame, 'tick'> = { held: 0, pressed: 0, released: 0, look: [0, 0] };

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, ...idle, ...overrides };
}

/** Steps the simulation, returning the events produced and the guard's last state. */
function run(simulation: FlowSimulation, ticks: number, input: (tick: number) => InputFrame = frame) {
  const events: GameEvent[] = [];
  let last: SimulationSnapshot | undefined;
  for (let tick = 1; tick <= ticks; tick += 1) {
    const output = simulation.step(input(tick), 1 / 60);
    events.push(...output.events);
    last = output.snapshot;
  }
  const guard = last?.entities.find((entity) => entity.kind === 'bot');
  if (!guard) throw new Error('Expected the arena to still contain its guard.');
  return { events, guard };
}

/** Fires on the first tick, before a turn rate has moved anything. */
function firstHit(simulation: FlowSimulation): GameEvent | undefined {
  const { events } = run(simulation, 2, (tick) => (tick === 1 ? frame(tick, { held: Action.Fire, pressed: Action.Fire }) : frame(tick)));
  return events.find((event) => event.kind === 'hit' && event.targetEntityId !== 1);
}

/**
 * Facing is a yaw whose forward is `(sin, cos)`, so a bot at -Z looking back at a
 * player at the origin is at yaw 0, and a quarter turn puts the player on its flank.
 */
const FACING_PLAYER = 0;
const FACING_ACROSS = Math.PI / 2;
const FACING_AWAY = Math.PI;

describe('the bulwark has to be flanked, not out-shot', () => {
  it('scales a shot into the plate down and says so', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena({ id: 'guard', kind: 'bot-bulwark', position: [0, 1, -10], rotationY: FACING_PLAYER })));
    const hit = firstHit(simulation);
    expect(hit).toBeDefined();
    expect(hit?.deflected).toBe(true);
    expect(hit?.value).toBeCloseTo(rifle.damage * botProfiles.bulwark.shield!.damageScale, 4);
    simulation.dispose();
  });

  it('takes a shot from outside the arc in full', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena({ id: 'guard', kind: 'bot-bulwark', position: [0, 1, -10], rotationY: FACING_ACROSS })));
    const hit = firstHit(simulation);
    expect(hit?.deflected).toBe(false);
    expect(hit?.value).toBeCloseTo(rifle.damage, 4);
    simulation.dispose();
  });

  it('leaves a bot with no shield alone', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena({ id: 'guard', kind: 'bot-ranged', position: [0, 1, -10], rotationY: FACING_PLAYER })));
    const hit = firstHit(simulation);
    expect(hit?.deflected).toBe(false);
    expect(hit?.value).toBeCloseTo(rifle.damage, 4);
    simulation.dispose();
  });

  it('turns at the profile rate instead of snapping round', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena({ id: 'guard', kind: 'bot-bulwark', position: [0, 1, -14], rotationY: FACING_AWAY })));
    const { guard: half } = run(simulation, 30);
    // Half a second of turning at 1.5 rad/s is 0.75 rad off a half turn, not zero.
    expect(Math.abs(half.rotationY)).toBeGreaterThan(Math.PI - 0.9);
    expect(Math.abs(half.rotationY)).toBeLessThan(Math.PI - 0.6);

    const { guard: settled } = run(simulation, 180);
    // Given time it does come round, so the shield is a window, not a wall.
    expect(Math.abs(settled.rotationY)).toBeLessThan(0.2);
    simulation.dispose();
  });

  it('faces the player immediately when the profile has no turn rate', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena({ id: 'guard', kind: 'bot-ranged', position: [0, 1, -14], rotationY: FACING_AWAY })));
    // Not exactly zero: the bot has strafed a few centimetres off the axis by the
    // time it is sampled, and a snap-facing bot points at where the player *is*.
    expect(Math.abs(run(simulation, 1).guard.rotationY)).toBeLessThan(0.05);
    simulation.dispose();
  });

  it('cannot shoot what it has not turned to', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena({ id: 'guard', kind: 'bot-bulwark', position: [0, 1, -6], rotationY: FACING_AWAY })));
    // A half turn at 1.5 rad/s takes about two seconds; nothing may commit before it.
    expect(run(simulation, 60).events.some((event) => event.kind === 'enemyTelegraph')).toBe(false);
    expect(run(simulation, 260).events.some((event) => event.kind === 'enemyTelegraph')).toBe(true);
    simulation.dispose();
  });

  it('publishes the health its bar is measured against', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena({ id: 'guard', kind: 'bot-bulwark', position: [0, 1, -10], rotationY: FACING_PLAYER })));
    const { guard } = run(simulation, 1);
    expect(guard.maxHealth).toBe(botProfiles.bulwark.health);
    expect(guard.profile).toBe('bulwark');
    simulation.dispose();
  });
});
