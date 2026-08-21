import { describe, expect, it } from 'vitest';
import { Action, type BladeStyleId, type InputFrame, type LegacyLevelDocumentV1, type LevelPrimitive, type SpawnDefinition, type Vec3 } from '../src/contracts';
import { lifesteal, lifestealForKill, playerHealth } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function box(id: string, position: Vec3, scale: Vec3): LevelPrimitive {
  return { id, kind: 'box', transform: { position, rotation: [0, 0, 0], scale }, color: '#8899aa', collision: true, surface: 'default' };
}

function frame(tick: number, patch: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...patch };
}

/**
 * A room, staged the way `?scene=crowd` stages one: hostiles in an arc inside the blade's
 * envelope, no encounter gating, and the player facing them.
 */
function room(kinds: SpawnDefinition['kind'][]): LegacyLevelDocumentV1 {
  const spawns: SpawnDefinition[] = [{ id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 }];
  kinds.forEach((kind, index) => {
    const angle = -0.7 + (index / Math.max(1, kinds.length - 1)) * 1.4;
    spawns.push({ id: `hostile-${index}`, kind, position: [Math.sin(angle) * 6, 1, -4 - Math.cos(angle) * 3], rotationY: 0 });
  });
  return {
    schemaVersion: 1,
    id: 'lifesteal-room',
    name: 'Lifesteal Room',
    units: 'meters',
    primitives: [box('floor', [0, -0.5, -20], [60, 1, 90])],
    spawns,
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -200],
  };
}

/** Holds the blade down until the room is clear or the player goes down. */
async function fight(kinds: SpawnDefinition['kind'][], blade: BladeStyleId = 'tempo', maxTicks = 1800) {
  const simulation = new FlowSimulation(undefined, undefined, null, blade);
  await simulation.loadLevel(cookLevel(room(kinds)));
  const heals: number[] = [];
  let taken = 0;
  let kills = 0;
  let ticks = 0;
  let health = playerHealth;
  let cleared = false;
  let died = false;
  for (let tick = 1; tick <= maxTicks; tick += 1) {
    const output = simulation.step(frame(tick, { held: Action.Slash }), TICK);
    ticks = tick;
    const playerId = output.snapshot.entities[0].id;
    for (const event of output.events) {
      if (event.kind === 'heal') heals.push(event.value ?? 0);
      if (event.kind === 'kill') kills += 1;
      if (event.kind === 'hit' && event.targetEntityId === playerId) taken += event.value ?? 0;
    }
    health = output.snapshot.player.health;
    died = output.snapshot.player.awaitingRespawn;
    cleared = output.snapshot.entities.every((entity) => entity.kind !== 'bot');
    if (cleared || died) break;
  }
  simulation.dispose();
  return { heals, healed: heals.reduce((total, value) => total + value, 0), taken, kills, health, seconds: ticks / 60, cleared, died };
}

const FIVE_BRAWLERS: SpawnDefinition['kind'][] = Array.from({ length: 5 }, () => 'bot-aggressive' as const);

describe('life from damage', () => {
  it('pays a kill at the chain multiplier, and caps it', () => {
    // The shape of the mechanic, stated once: linear in the chain, hard-capped. The cap
    // and the reference blade's multiplier ceiling land on the same number rather than
    // the cap quietly overriding the curve.
    expect(lifestealForKill(1)).toBe(lifesteal.perKill);
    expect(lifestealForKill(2)).toBe(lifesteal.perKill * 2);
    expect(lifestealForKill(3)).toBe(lifesteal.maxPerKill);
    // Riposte reaches 4.0 with its link bonus, and is capped there: the defensive blade
    // may not also be the sustain blade.
    expect(lifestealForKill(4)).toBe(lifesteal.maxPerKill);
  });

  it('returns health on a kill, and more of it when the chain is longer', async () => {
    const fought = await fight(FIVE_BRAWLERS);
    expect(fought.cleared).toBe(true);
    expect(fought.kills).toBe(5);
    expect(fought.heals).toHaveLength(5);
    // Measured on this room: the chain climbs as the room clears, so the last kill pays
    // more than the first. That is the whole design -- the health economy is the style
    // meter's second dimension.
    expect(fought.heals.at(-1)!).toBeGreaterThan(fought.heals[0]);
    expect(fought.heals[0]).toBeCloseTo(lifesteal.perKill * 1.1, 5);
  });

  it('makes five brawlers survivable for a player who keeps swinging, and only just', async () => {
    // The measurement that justifies the numbers. Five brawlers on top of a stationary
    // player is about 92 damage a second; this drive never dodges, never moves and never
    // reaches for the heavy, which is the worst case a player can actually produce.
    const fought = await fight(FIVE_BRAWLERS);
    expect(fought.taken).toBeGreaterThan(100);
    // Healed enough to matter -- a quarter of the pool -- and nowhere near enough to make
    // the exchange free. Without it the same fight ends in single figures.
    expect(fought.healed).toBeGreaterThan(playerHealth * 0.2);
    expect(fought.healed).toBeLessThan(fought.taken * 0.45);
    expect(fought.health).toBeGreaterThan(30);
    expect(fought.health).toBeLessThan(playerHealth * 0.6);
  });

  it('is the only healing there is: nothing comes back for waiting', async () => {
    const simulation = new FlowSimulation(undefined, undefined, null, 'tempo');
    await simulation.loadLevel(cookLevel(room(['bot-aggressive'])));
    let output = simulation.step(frame(1), TICK);
    // Take some damage, then clear the room and stand still for five seconds.
    for (let tick = 2; tick <= 240; tick += 1) output = simulation.step(frame(tick, { held: Action.Slash }), TICK);
    const settled = output.snapshot.player.health;
    expect(settled).toBeLessThan(playerHealth);
    for (let tick = 241; tick <= 540; tick += 1) output = simulation.step(frame(tick), TICK);
    // Not a rounding allowance: the answer to being hurt is to fight better, and a regen
    // that rewards disengaging would fight everything the crowd pass built.
    expect(output.snapshot.player.health).toBe(settled);
    simulation.dispose();
  });

  it('never overfills the pool, and says nothing when there is nothing to give back', async () => {
    const simulation = new FlowSimulation(undefined, undefined, null, 'tempo');
    // One hostile the player can reach before it can answer, so the kill lands at or near
    // full health: a heal that healed nothing must not reach presentation at all.
    await simulation.loadLevel(cookLevel(room(['bot-ranged'])));
    let heals = 0;
    let peak = 0;
    for (let tick = 1; tick <= 600; tick += 1) {
      const output = simulation.step(frame(tick, { held: Action.Slash }), TICK);
      heals += output.events.filter((event) => event.kind === 'heal').length;
      peak = Math.max(peak, output.snapshot.player.health);
      if (output.snapshot.entities.every((entity) => entity.kind !== 'bot')) break;
    }
    expect(peak).toBeLessThanOrEqual(playerHealth);
    // A hunter at eighteen metres does get shots off while the player closes, so this is
    // not asserting zero heals -- it is asserting that whatever was paid fitted in the
    // hole, which is what `heal` returning the amount actually given is for.
    expect(heals).toBeLessThanOrEqual(1);
    simulation.dispose();
  });

  it('lets the aggressive blade out-sustain the reference one without a field saying so', async () => {
    // Cleave pays two links a kill, so its chain -- and therefore its healing -- grows
    // twice as fast per body. This is why there is no per-style lifesteal number: the
    // variation the styles argue for is already in the chain rules.
    const tempo = await fight(FIVE_BRAWLERS, 'tempo');
    const cleave = await fight(FIVE_BRAWLERS, 'cleave');
    const perKill = (fought: { healed: number; kills: number }) => fought.healed / Math.max(1, fought.kills);
    expect(perKill(cleave)).toBeGreaterThan(perKill(tempo));
  });
});
