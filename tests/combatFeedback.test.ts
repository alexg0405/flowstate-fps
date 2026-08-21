import { describe, expect, it } from 'vitest';
import { Action, type GameEvent, type InputFrame, type LegacyLevelDocumentV1 } from '../src/contracts';
import { botProfiles } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';
import { defaultBuildFor } from '../src/content/weapons';

/** Flat arena with the player facing -Z, so a bot ahead of them has a clear line. */
function arena(overrides: Partial<LegacyLevelDocumentV1> = {}): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'combat-feedback',
    name: 'Combat Feedback',
    units: 'meters',
    primitives: [{
      id: 'floor', kind: 'box', color: '#fff', collision: true, surface: 'default',
      transform: { position: [0, -0.5, -20], rotation: [0, 0, 0], scale: [40, 1, 80] },
    }],
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 },
      { id: 'guard', kind: 'bot-ranged', position: [0, 1, -10], rotationY: 0 },
    ],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -200],
    ...overrides,
  };
}

const idle: Omit<InputFrame, 'tick'> = { held: 0, pressed: 0, released: 0, look: [0, 0] };

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  // Every case in this file is about the gun, and the gun is a *selection* now rather
  // than the weapon the player starts a run holding. Drawing it costs a bit rather than
  // a frame: selection resolves at the top of `updateCombat`, before the trigger is read.
  const input: InputFrame = { tick, ...idle, ...overrides };
  return { ...input, pressed: input.pressed | Action.SelectGunOne };
}

/** Runs until `predicate` is satisfied, returning every event produced on the way. */
function runUntil(
  simulation: FlowSimulation,
  ticks: number,
  predicate: (events: readonly GameEvent[]) => boolean,
  input: (tick: number) => InputFrame = frame,
): GameEvent[] {
  const collected: GameEvent[] = [];
  for (let tick = 1; tick <= ticks; tick += 1) {
    const output = simulation.step(input(tick), 1 / 60);
    collected.push(...output.events);
    if (predicate(output.events)) break;
  }
  return collected;
}

describe('enemy fire is telegraphed before it resolves', () => {
  it('announces the wind-up and only then resolves the shot', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena()));
    const events = runUntil(simulation, 300, (batch) => batch.some((event) => event.kind === 'enemyAttack'));

    const telegraph = events.find((event) => event.kind === 'enemyTelegraph');
    const attack = events.find((event) => event.kind === 'enemyAttack');
    expect(telegraph).toBeDefined();
    expect(attack).toBeDefined();
    // The telegraph is the player's only warning, so it must lead the damage by
    // roughly the profile's wind-up rather than landing on the same tick.
    const leadTicks = attack!.tick - telegraph!.tick;
    expect(leadTicks).toBeGreaterThanOrEqual(Math.floor(botProfiles.ranged.windupSeconds * 60) - 1);
    expect(telegraph!.sourceEntityId).toBe(attack!.sourceEntityId);
    simulation.dispose();
  });

  it('carries a muzzle origin and an impact point so the shot can be drawn', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena()));
    const events = runUntil(simulation, 300, (batch) => batch.some((event) => event.kind === 'enemyAttack'));
    const attack = events.find((event) => event.kind === 'enemyAttack')!;

    expect(attack.origin).toBeDefined();
    expect(attack.position).toBeDefined();
    // A trace with no length cannot be drawn, and would place the sound on top of
    // the player rather than out at the shooter.
    const [ox, oy, oz] = attack.origin!;
    const [px, py, pz] = attack.position!;
    expect(Math.hypot(px - ox, py - oy, pz - oz)).toBeGreaterThan(0.5);
    simulation.dispose();
  });

  it('attributes the shot to the player even when it misses, and reports zero damage', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena()));
    const events = runUntil(simulation, 600, (batch) => batch.some((event) => event.kind === 'enemyAttack'));
    for (const attack of events.filter((event) => event.kind === 'enemyAttack')) {
      expect(attack.targetEntityId).toBe(1);
      expect(attack.value).toBeGreaterThanOrEqual(0);
      // Damage only ever arrives with a matching `hit`, so the mix and the HUD
      // agree on whether the shot connected.
      const landed = events.some((event) => event.kind === 'hit' && event.tick === attack.tick && event.targetEntityId === 1);
      expect(landed).toBe((attack.value ?? 0) > 0);
    }
    simulation.dispose();
  });

  it('defeats a committed shot when the player breaks the line during the wind-up', async () => {
    // A pillar between the two, with the player starting in the open beside it.
    const level = arena();
    level.primitives.push({
      id: 'pillar', kind: 'box', color: '#333', collision: true, surface: 'no-traverse',
      transform: { position: [0, 2, -5], rotation: [0, 0, 0], scale: [6, 5, 1] },
    });
    level.spawns[0] = { id: 'player', kind: 'player', position: [7, 1, 0], rotationY: 0 };
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(level));

    // Sprint left, behind the pillar, for long enough to cross a whole wind-up.
    const events = runUntil(
      simulation,
      420,
      () => false,
      (tick) => frame(tick, { held: Action.Left | Action.Sprint }),
    );
    const landed = events.filter((event) => event.kind === 'hit' && event.targetEntityId === 1);
    const telegraphs = events.filter((event) => event.kind === 'enemyTelegraph');
    expect(telegraphs.length).toBeGreaterThan(0);
    // Some shots may land before cover is reached; the point is that committing is
    // no longer the same thing as connecting.
    expect(landed.length).toBeLessThan(telegraphs.length);
    simulation.dispose();
  });

  it('resets a pending wind-up when a checkpoint restore re-seats the bot', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena()));
    runUntil(simulation, 300, (batch) => batch.some((event) => event.kind === 'enemyTelegraph'));
    simulation.restoreCheckpoint();
    // The telegraph the player already heard must not resolve into damage from the
    // other side of a respawn.
    const after = runUntil(simulation, 6, () => false);
    expect(after.some((event) => event.kind === 'enemyAttack')).toBe(false);
    simulation.dispose();
  });
});

describe('player weapon feedback', () => {
  it('clicks once on a dry trigger and never strands the firing action', async () => {
    const level = arena({ spawns: [{ id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 }] });
    // Quickfeed keeps the magazine and reload short, so the whole reserve burns
    // down inside the loop below.
    const build = { ...defaultBuildFor('dmr', 'dry', 'Dry'), parts: { magazine: 'magazine.quickfeed' } };
    const simulation = new FlowSimulation(undefined, [build, build]);
    await simulation.loadLevel(cookLevel(level));

    // Burn the magazine and the reserve, then keep holding the trigger.
    let dryFires = 0;
    let run = 0;
    let longestFiringRun = 0;
    let action = 'neutral';
    for (let tick = 1; tick <= 3000; tick += 1) {
      const output = simulation.step(frame(tick, { held: Action.Attack, pressed: tick === 1 ? Action.Attack : 0 }), 1 / 60);
      dryFires += output.events.filter((event) => event.kind === 'dryFire').length;
      action = output.snapshot.player.action;
      const empty = output.snapshot.player.ammo === 0 && output.snapshot.player.reserveAmmo === 0;
      run = empty && action === 'firing' ? run + 1 : 0;
      longestFiringRun = Math.max(longestFiringRun, run);
    }
    // Holding the trigger reports the empty weapon once, not once per tick.
    expect(dryFires).toBe(1);
    // The last round is still allowed its own fire cooldown. What must not happen is
    // the action staying `firing` for as long as the trigger is held, which is what
    // the empty branch's early return used to cause.
    const cooldownTicks = Math.ceil((60 / 260) * 60);
    expect(longestFiringRun).toBeLessThanOrEqual(cooldownTicks + 2);
    expect(action).toBe('neutral');
    simulation.dispose();
  });

  it('scatters pellets in a cone of the same angular size wherever the player aims', async () => {
    const level = arena({ spawns: [{ id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 }] });
    const shotgun = defaultBuildFor('shotgun', 'shotgun', 'Shotgun');

    const spreadFor = async (look: readonly [number, number]): Promise<number> => {
      const simulation = new FlowSimulation(undefined, [shotgun, shotgun]);
      await simulation.loadLevel(cookLevel(level));
      // Aim first, then fire on a later tick so the look has already applied.
      simulation.step(frame(1, { look: [look[0], look[1]] }), 1 / 60);
      const output = simulation.step(frame(2, { held: Action.Attack, pressed: Action.Attack }), 1 / 60);
      const camera = output.snapshot.camera.position;
      const angles = output.events
        .filter((event) => event.kind === 'impact' && event.position)
        .map((event) => {
          const [x, y, z] = event.position!;
          const dx = x - camera[0];
          const dy = y - camera[1];
          const dz = z - camera[2];
          return { dx, dy, dz, length: Math.hypot(dx, dy, dz) };
        });
      expect(angles.length).toBeGreaterThan(1);
      // Widest angle between any two pellets, which is the pattern's real size.
      let widest = 0;
      for (const a of angles) {
        for (const b of angles) {
          const dot = (a.dx * b.dx + a.dy * b.dy + a.dz * b.dz) / Math.max(1e-6, a.length * b.length);
          widest = Math.max(widest, Math.acos(Math.min(1, Math.max(-1, dot))));
        }
      }
      simulation.dispose();
      return widest;
    };

    // Level, then pitched steeply up. Perturbing world components made the cone
    // collapse along whichever axis the view was aligned with; a camera-space cone
    // keeps the same angular size.
    const level0 = await spreadFor([0, 0]);
    const pitched = await spreadFor([0, -700]);
    expect(level0).toBeGreaterThan(0);
    expect(pitched).toBeGreaterThan(0);
    expect(Math.abs(pitched - level0)).toBeLessThan(level0 * 0.6);
  });
});
