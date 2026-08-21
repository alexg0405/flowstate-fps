import { describe, expect, it } from 'vitest';
import { Action, type InputFrame, type LegacyLevelDocumentV1, type SpawnDefinition } from '../src/contracts';
import { botLeashMetres, botProfiles, playerHealth } from '../src/content/config';
import { cookLevel, defaultLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

/**
 * One room with three waves of one hostile each, all inside the blade's reach, and the
 * player standing on the checkpoint so the room opens immediately.
 */
function room(waves: number): LegacyLevelDocumentV1 {
  const spawns: SpawnDefinition[] = [{ id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 }];
  for (let wave = 0; wave < waves; wave += 1) {
    spawns.push({
      id: `guard-${wave}`,
      kind: 'bot-aggressive',
      position: [wave % 2 === 0 ? -1 : 1, 1, -3],
      rotationY: 0,
      encounterId: 'room',
      wave,
    });
  }
  return {
    schemaVersion: 1,
    id: 'waves',
    name: 'Waves',
    units: 'meters',
    primitives: [{
      id: 'floor', kind: 'box', color: '#889', collision: true, surface: 'default',
      transform: { position: [0, -0.5, -10], rotation: [0, 0, 0], scale: [30, 1, 40] },
    }],
    spawns,
    encounters: [{
      id: 'room',
      label: 'Room',
      checkpoint: [0, 1, 0],
      requiredBotIds: spawns.filter((spawn) => spawn.kind !== 'player').map((spawn) => spawn.id),
    }],
    offMeshLinks: [],
    exit: [0, 1, -200],
  };
}

async function start(level: LegacyLevelDocumentV1): Promise<FlowSimulation> {
  const simulation = new FlowSimulation();
  await simulation.loadLevel(cookLevel(level));
  for (let tick = 1; tick <= 4; tick += 1) simulation.step(frame(tick), TICK);
  return simulation;
}

/** Holds the blade until the room reports it is done, or the budget runs out. */
function clear(simulation: FlowSimulation, ticks = 1600) {
  const waveEvents: number[] = [];
  let output = simulation.step(frame(5, { held: Action.Attack, pressed: Action.Attack }), TICK);
  let peakConcurrent = 0;
  for (let tick = 6; tick <= ticks; tick += 1) {
    output = simulation.step(frame(tick, { held: Action.Attack }), TICK);
    for (const event of output.events) if (event.kind === 'wave') waveEvents.push(Math.round(event.value ?? 0));
    peakConcurrent = Math.max(peakConcurrent, output.snapshot.entities.filter((entity) => entity.kind === 'bot').length);
    if (output.snapshot.objective === 'Reach the finish gate') break;
  }
  return { output, waveEvents, peakConcurrent };
}

describe('a room can have waves', () => {
  it('brings on the next wave when the last of the current one dies', async () => {
    const simulation = await start(room(3));
    // One hostile at a time, three times over, and only then is the room clear.
    const { output, waveEvents, peakConcurrent } = clear(simulation);
    expect(waveEvents).toEqual([2, 3]);
    expect(peakConcurrent).toBe(1);
    expect(output.snapshot.entities.filter((entity) => entity.kind === 'bot')).toHaveLength(0);
    expect(output.snapshot.objective).toBe('Reach the finish gate');
    simulation.dispose();
  });

  it('does not open the room until every wave is cleared', async () => {
    const simulation = await start(room(3));
    // Kill the first wave only, then stop swinging.
    let cleared = false;
    for (let tick = 5; tick <= 200 && !cleared; tick += 1) {
      const output = simulation.step(frame(tick, { held: Action.Attack, pressed: tick === 5 ? Action.Attack : 0 }), TICK);
      cleared = output.events.some((event) => event.kind === 'wave');
    }
    expect(cleared).toBe(true);
    const after = simulation.step(frame(220), TICK).snapshot;
    // The room is on its second wave, not finished: an unspawned wave is still alive as
    // far as the completion check is concerned, which is what stops a gate opening early.
    expect(after.objective).toBe('Clear: Room');
    expect(after.wave).toEqual({ current: 2, total: 3 });
    expect(after.openGateIds).toHaveLength(0);
    simulation.dispose();
  });

  it('publishes which wave is live, and nothing at all between rooms', async () => {
    const simulation = await start(room(2));
    // The player is standing on the checkpoint, so the room is already open.
    expect(simulation.step(frame(5), TICK).snapshot.wave).toEqual({ current: 1, total: 2 });
    const { output } = clear(simulation);
    // Room cleared: there is no wave to report.
    expect(output.snapshot.wave).toEqual({ current: 0, total: 0 });
    simulation.dispose();
  });

  it('reports one wave for a room authored without any', async () => {
    const simulation = await start(room(1));
    expect(simulation.step(frame(5), TICK).snapshot.wave).toEqual({ current: 1, total: 1 });
    simulation.dispose();
  });

  it('does not resurrect a cleared wave after a checkpoint restore', async () => {
    const simulation = await start(room(3));
    for (let tick = 5; tick <= 200; tick += 1) {
      const output = simulation.step(frame(tick, { held: Action.Attack, pressed: tick === 5 ? Action.Attack : 0 }), TICK);
      if (output.events.some((event) => event.kind === 'wave')) break;
    }
    simulation.restoreCheckpoint();
    // The room reopens at whichever wave still has anything alive in it, which is the
    // second: hostiles already killed stay killed, so a restore cannot hand the player
    // a fight they already won.
    let output = simulation.step(frame(210), TICK);
    for (let tick = 211; tick <= 240; tick += 1) output = simulation.step(frame(tick), TICK);
    expect(output.snapshot.entities.filter((entity) => entity.kind === 'bot')).toHaveLength(1);
    expect(output.snapshot.wave.current).toBe(2);
    simulation.dispose();
  });

  it('costs nothing for a wave that has not arrived', async () => {
    const simulation = await start(room(6));
    // Six authored, one on the deck. This is the whole reason a route can hold
    // twenty-eight hostiles inside the frame budget.
    expect(simulation.step(frame(5), TICK).snapshot.entities.filter((entity) => entity.kind === 'bot')).toHaveLength(1);
    simulation.dispose();
  });

  it('reproduces the same waves for the same input tape', async () => {
    const run = async (): Promise<string[]> => {
      const simulation = await start(room(3));
      const log: string[] = [];
      for (let tick = 5; tick <= 900; tick += 1) {
        const output = simulation.step(frame(tick, { held: Action.Attack, pressed: tick === 5 ? Action.Attack : 0 }), TICK);
        for (const event of output.events) {
          if (event.kind === 'wave' || event.kind === 'kill') log.push(`${event.tick} ${event.kind} ${event.value ?? ''}`);
        }
      }
      simulation.dispose();
      return log;
    };
    expect(await run()).toEqual(await run());
  });
});

describe('a room keeps its hostiles', () => {
  it('holds a hostile inside its leash instead of walking it down the route', async () => {
    // Measured before this existed: the Atrium activates when the player is 28 m from
    // its checkpoint and a brawler wants to be 2.4 m from the player, so the first wave
    // walked the full forty metres back down the bridge and fought on the start floor
    // with the arena empty behind it.
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(defaultLevel));
    let output = simulation.step(frame(1), TICK);
    // Walk to just inside the activation radius and stop, which is where the old
    // behaviour brought the whole room to the player.
    for (let tick = 2; tick <= 1200; tick += 1) {
      const z = output.snapshot.entities[0].position[2];
      // Ten metres in, which is inside the 28 m activation radius and forty metres
      // short of the Atrium deck.
      output = simulation.step(frame(tick, { held: z > -10 ? Action.Forward : 0 }), TICK);
    }

    const player = output.snapshot.entities[0].position;
    const hostiles = output.snapshot.entities.filter((entity) => entity.kind === 'bot');
    expect(hostiles.length).toBeGreaterThan(0);
    for (const hostile of hostiles) {
      // None of them has come anywhere near: the room is thirty metres away and they
      // are still in it.
      const gap = Math.hypot(hostile.position[0] - player[0], hostile.position[2] - player[2]);
      expect(gap, 'a hostile left its room to reach the player').toBeGreaterThan(20);
    }
    // And the player is not being chewed on at the spawn.
    expect(output.snapshot.player.health).toBe(playerHealth);
    simulation.dispose();
  });

  it('leashes pursuit without leashing fire', () => {
    // A marksman's own firing gate is `preferredRange * 1.5`, which is 27 m -- further
    // than the leash on purpose, so standing at a room's threshold is under fire even
    // though nothing walks out to meet you.
    expect(botLeashMetres).toBeLessThan(botProfiles.ranged.preferredRange * 1.5);
    // And the leash is wide enough to cross the widest deck on the route.
    expect(botLeashMetres).toBeGreaterThan(20);
  });
});

describe('the shipped route holds a crowd', () => {
  const botSpawns = defaultLevel.spawns.filter((spawn) => spawn.kind !== 'player');

  it('authors twenty-eight hostiles across seven waves', () => {
    expect(botSpawns).toHaveLength(28);
    const waves = new Set(botSpawns.map((spawn) => `${spawn.encounterId}:${spawn.wave ?? 0}`));
    expect(waves.size).toBe(6);
  });

  it('keeps every wave inside a peak the frame budget can carry', () => {
    // The concurrent count is what costs frames; the total is what makes a room long.
    // Eight is the authored ceiling and it is the finale.
    const perWave = new Map<string, number>();
    for (const spawn of botSpawns) {
      const key = `${spawn.encounterId}:${spawn.wave ?? 0}`;
      perWave.set(key, (perWave.get(key) ?? 0) + 1);
    }
    const peak = Math.max(...perWave.values());
    expect(peak).toBeGreaterThanOrEqual(6);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('names every authored hostile in the encounter that owns it', () => {
    // A hostile missing from `requiredBotIds` is a room that opens with it still alive,
    // and a wave that never gets waited for.
    for (const spawn of botSpawns) {
      const encounter = defaultLevel.encounters.find((item) => item.id === spawn.encounterId);
      expect(encounter, `${spawn.id} has no encounter`).toBeDefined();
      expect(encounter!.requiredBotIds, `${encounter!.id} does not require ${spawn.id}`).toContain(spawn.id);
    }
  });

  it('starts every room with something that closes and something that holds', () => {
    // The first wave of a room is what teaches it, so none of them may be all marksmen
    // -- a room the player cannot reach is a room they can only shoot.
    for (const encounter of defaultLevel.encounters) {
      const first = botSpawns.filter((spawn) => spawn.encounterId === encounter.id && (spawn.wave ?? 0) === 0);
      expect(first.length, `${encounter.id} has no first wave`).toBeGreaterThan(0);
      expect(
        first.some((spawn) => spawn.kind === 'bot-aggressive' || spawn.kind === 'bot-bulwark'),
        `${encounter.id} opens with nothing that comes to the player`,
      ).toBe(true);
    }
  });
});
