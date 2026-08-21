import { describe, expect, it } from 'vitest';
import { Action, type CollisionPrimitiveV2, type InputFrame, type LevelDocumentV2, type SpawnDefinition } from '../src/contracts';
import { botProfiles, movementProfile, playerHealth } from '../src/content/config';
import { DEFAULT_ASSET_CATALOG_VERSION, DEFAULT_ENVIRONMENT_PRESET_ID, navigationFlagsFor, traversalFlagsFor } from '../src/content/migrations';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;
const profile = botProfiles.resonator;

function floor(id: string, position: [number, number, number], scale: [number, number, number]): CollisionPrimitiveV2 {
  return {
    id, kind: 'box', transform: { position, rotation: [0, 0, 0], scale }, color: '#ffffff',
    collision: true, surface: 'default',
    traversal: traversalFlagsFor('default', true), nav: navigationFlagsFor('default', true),
  };
}

/**
 * A flat pad, a player and one Resonator at a chosen distance.
 *
 * Deliberately featureless: the only variable is what the player does with their feet,
 * which is the only thing this enemy asks about.
 */
function arena(spawns: SpawnDefinition[]): LevelDocumentV2 {
  const collision = [floor('pad', [0, -0.5, 0], [60, 1, 60])];
  return {
    schemaVersion: 2, id: 'resonator-pad', name: 'Resonator pad', units: 'meters',
    collision, visuals: [], lights: [],
    environmentPresetId: DEFAULT_ENVIRONMENT_PRESET_ID, assetCatalogVersion: DEFAULT_ASSET_CATALOG_VERSION,
    primitives: collision, spawns, encounters: [], offMeshLinks: [], vistaHints: [],
    exit: [0, 1, -28],
  };
}

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

/**
 * Runs one wave and reports what happened to the player.
 *
 * `act` decides the input for each tick, so a test can hold still, hold a jump, or dash
 * at the moment the wave arrives.
 */
async function survive(
  distance: number,
  ticks: number,
  act: (tick: number, state: { telegraph?: number; radius?: number }) => Partial<InputFrame> = () => ({}),
) {
  const simulation = new FlowSimulation();
  await simulation.loadLevel(cookLevel(arena([
    { id: 'player', kind: 'player', position: [0, 1.1, 0], rotationY: 0 },
    { id: 'boomer', kind: 'bot-resonator', position: [0, 1.1, -distance], rotationY: 0 },
  ])));

  let telegraphs = 0;
  let resonances = 0;
  let hits = 0;
  let dodges = 0;
  let peakRadius = 0;
  let health = playerHealth;
  let state: { telegraph?: number; radius?: number } = {};

  for (let tick = 1; tick <= ticks; tick += 1) {
    const output = simulation.step(frame(tick, act(tick, state)), TICK);
    health = output.snapshot.player.health;
    for (const event of output.events) {
      if (event.kind === 'enemyTelegraph') telegraphs += 1;
      if (event.kind === 'resonance') resonances += 1;
      if (event.kind === 'hit' && event.targetEntityId === output.snapshot.entities[0].id) hits += 1;
      if (event.kind === 'dodge') dodges += 1;
    }
    const bot = output.snapshot.entities.find((entity) => entity.profile === 'resonator');
    state = { telegraph: bot?.telegraph, radius: bot?.pulse?.radius };
    if (state.radius !== undefined) peakRadius = Math.max(peakRadius, state.radius);
  }
  simulation.dispose();
  return { telegraphs, resonances, hits, dodges, peakRadius, health };
}

describe('the Resonator is a profile, not a re-skin', () => {
  it('carries a ground wave and no other profile does', () => {
    expect(profile.pulse).toBeDefined();
    for (const other of ['ranged', 'aggressive', 'bulwark'] as const) {
      expect(botProfiles[other].pulse).toBeUndefined();
    }
  });

  it('is low health and slow, because it is not meant to be a damage race', () => {
    expect(profile.health).toBeLessThan(botProfiles.aggressive.health);
    expect(profile.moveSpeed).toBeLessThan(botProfiles.bulwark.moveSpeed);
  });

  it('spreads fast enough that running is not the answer inside its own range', () => {
    // The number that makes this a movement question rather than a footrace, stated as
    // the arithmetic rather than as a threshold. A wave leaving from distance `d` catches
    // a retreating sprinter at `t = d / (speed - sprint)`, by which point it has covered
    // `speed * t`. It only lands if that is still inside `reach`.
    const { speed, reach } = profile.pulse!;
    const escape = movementProfile.sprintSpeed;
    expect(speed).toBeGreaterThan(escape);
    const breakEven = (reach * (speed - escape)) / speed;
    // Anything inside the break-even must jump; the Resonator holds well inside it.
    expect(breakEven).toBeGreaterThan(profile.preferredRange);
  });

  it('keeps the telegraph the rest of the roster uses', () => {
    // Every hostile commits, announces, then resolves. A wave that skipped the middle
    // beat would be unfair rather than novel.
    expect(profile.windupSeconds).toBeGreaterThanOrEqual(0.8);
    expect(profile.windupSeconds).toBeGreaterThan(botProfiles.bulwark.windupSeconds);
  });
});

describe('the wave answers where the player is standing', () => {
  it('announces, then arrives, and hurts a player who did nothing', async () => {
    const run = await survive(9, 150);
    expect(run.telegraphs).toBeGreaterThanOrEqual(1);
    expect(run.resonances).toBeGreaterThanOrEqual(1);
    expect(run.hits).toBeGreaterThanOrEqual(1);
    expect(run.health).toBeLessThan(playerHealth);
  });

  it('misses a player who is off the floor when it arrives', async () => {
    // Jumped as the band reaches them, not when the telegraph starts -- and that
    // distinction is the skill in the enemy rather than an artefact of the test. At nine
    // metres the wave takes 0.6 s to arrive, which is longer than a jump hangs, so
    // panicking on the telegraph puts the player back on the deck exactly in time to be
    // caught. The counter is timed, not pre-emptive.
    const lead = 9 - profile.pulse!.speed * 0.3;
    const run = await survive(9, 150, (_tick, state) => (
      state.radius !== undefined && state.radius > lead ? { pressed: Action.Jump, held: Action.Jump } : {}
    ));
    expect(run.telegraphs).toBeGreaterThanOrEqual(1);
    expect(run.resonances).toBeGreaterThanOrEqual(1);
    // The wave still went out; it just did not find anyone at floor height.
    expect(run.hits).toBe(0);
    expect(run.health).toBe(playerHealth);
  });

  it('cannot be outrun once it is out, from inside the break-even', async () => {
    // Sprint away the instant the wave exists, from seven metres. It closes at 12 m/s
    // net and lands at fourteen, inside its twenty-metre reach.
    //
    // Retreating *before* it commits is a different question and a legitimate answer: a
    // player who turns and runs the moment they see a Resonator will not be caught,
    // because the eight-tenths telegraph is time they spend moving too. On this
    // featureless pad that works. In a 24 m arena they run out of floor first, which is
    // the situation the enemy is actually for.
    const run = await survive(7, 150, (_tick, state) => (
      state.radius !== undefined ? { held: Action.Back | Action.Sprint } : {}
    ));
    expect(run.hits).toBeGreaterThanOrEqual(1);
  });

  it('reaches its authored distance and then stops existing', async () => {
    const run = await survive(6, 240);
    expect(run.peakRadius).toBeGreaterThan(profile.pulse!.reach * 0.75);
    expect(run.peakRadius).toBeLessThanOrEqual(profile.pulse!.reach + profile.pulse!.speed * TICK + 1e-6);
  });

  it('hits at most once however long the player stays in the band', async () => {
    // One wave, one hit. Standing in it must not tick.
    const run = await survive(3, 60);
    expect(run.hits).toBeLessThanOrEqual(1);
  });

  it('does not wind up at a player it cannot reach', async () => {
    const run = await survive(profile.pulse!.reach + 8, 180);
    expect(run.telegraphs).toBe(0);
    expect(run.resonances).toBe(0);
  });
});

describe('the wave is answerable, as arithmetic', () => {
  /**
   * The three numbers that decide whether this enemy is fair, checked against each other
   * rather than eyeballed.
   *
   * A jump clears the band for a while and the band takes a while to pass. If the first
   * is not comfortably longer than the second, the enemy is a coin flip however good the
   * telegraph is -- and none of that is visible in any one of `jumpSpeed`, `pulse.height`
   * or `pulse.thickness` on its own.
   */
  const { gravity, jumpSpeed } = movementProfile;
  const { height, thickness, speed } = profile.pulse!;
  // Roots of `jumpSpeed * t - gravity * t^2 / 2 = height`.
  const discriminant = jumpSpeed * jumpSpeed - 2 * gravity * height;
  const aboveTheBand = discriminant > 0 ? (2 * Math.sqrt(discriminant)) / (2 * gravity) * 2 : 0;
  const bandPasses = thickness / speed;

  it('lets a jump clear the band at all', () => {
    const apex = (jumpSpeed * jumpSpeed) / (2 * gravity);
    expect(apex).toBeGreaterThan(height);
    expect(discriminant).toBeGreaterThan(0);
  });

  it('leaves a timing window rather than a frame-perfect one', () => {
    // About 0.40 s clear against 0.15 s of band, so roughly a quarter-second of slack in
    // when the jump goes. Tight enough to be a skill, wide enough to be learnable.
    expect(aboveTheBand).toBeGreaterThan(bandPasses * 2);
    expect(aboveTheBand - bandPasses).toBeGreaterThan(0.2);
  });

  it('still requires the jump to be timed, not panicked', () => {
    // Rising to the band's height costs time. A player who jumps the instant the
    // telegraph starts is back on the deck before a wave from any useful distance
    // arrives, which is why the counter is a read and not a reflex.
    const rise = (jumpSpeed - Math.sqrt(discriminant)) / gravity;
    expect(rise).toBeGreaterThan(0.1);
    expect(profile.windupSeconds).toBeGreaterThan(rise * 2);
  });
});

describe('the wave obeys the rules the rest of the game runs on', () => {
  it('only ever takes health through a hit, whatever the player does', async () => {
    // Dash-adjacent inputs around the arrival. The point is not which branch fires but
    // that the accounting holds: a dodge costs nothing, a hit costs exactly the profile's
    // damage, and there is no third path that quietly drains health.
    const run = await survive(9, 200, (_tick, state) => (
      state.radius !== undefined && state.radius > 9 - profile.pulse!.speed * 0.3
        ? { pressed: Action.Jump, held: Action.Jump | Action.Forward }
        : {}
    ));
    expect(playerHealth - run.health).toBe(run.hits * profile.damage);
  });

  it('publishes the wave so the floor can draw it, not the HUD', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena([
      { id: 'player', kind: 'player', position: [0, 1.1, 0], rotationY: 0 },
      { id: 'boomer', kind: 'bot-resonator', position: [0, 1.1, -8], rotationY: 0 },
    ])));
    let sawTelegraph = false;
    let sawPulse = false;
    for (let tick = 1; tick <= 150; tick += 1) {
      const bot = simulation.step(frame(tick), TICK).snapshot.entities.find((entity) => entity.profile === 'resonator');
      if (bot?.telegraph !== undefined) {
        sawTelegraph = true;
        expect(bot.telegraph).toBeGreaterThanOrEqual(0);
        expect(bot.telegraph).toBeLessThanOrEqual(1);
      }
      if (bot?.pulse) {
        sawPulse = true;
        expect(bot.pulse.radius).toBeGreaterThanOrEqual(0);
        expect(bot.pulse.height).toBe(profile.pulse!.height);
      }
    }
    simulation.dispose();
    expect(sawTelegraph).toBe(true);
    expect(sawPulse).toBe(true);
  });

  it('stays deterministic', async () => {
    const [a, b] = await Promise.all([survive(9, 200), survive(9, 200)]);
    expect(a).toEqual(b);
  });
});
