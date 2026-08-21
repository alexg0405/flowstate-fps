import { describe, expect, it } from 'vitest';
import { Action, type GameEvent, type InputFrame, type LegacyLevelDocumentV1, type Vec3 } from '../src/contracts';
import { botCapsule, botProfiles, playerCapsule } from '../src/content/config';
import { bladeStyle } from '../src/content/blades';

/** The blade a run carries unless the save says otherwise, and the reference envelope. */
const melee = bladeStyle('tempo');
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;
/**
 * Recovery in ticks, which is also how often a held blade may swing. Rounded up:
 * the timer is decremented before the swing is offered, so a recovery that is not a
 * whole number of ticks costs the tick it lands inside.
 */
const SLASH_TICKS = Math.ceil(melee.light.seconds * 60);

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

/**
 * Flat floor with the player at the origin facing -Z, and one hostile placed wherever
 * the case under test needs it. Nothing else: the blade's envelope is the subject, so
 * there is no geometry for a swing to be blocked by.
 */
function arena(
  bot: { kind: 'bot-ranged' | 'bot-aggressive' | 'bot-bulwark'; position: Vec3 } | null,
  options: { pin?: boolean } = {},
): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'blade',
    name: 'Blade',
    units: 'meters',
    primitives: [
      {
        id: 'floor', kind: 'box', color: '#889', collision: true, surface: 'default',
        transform: { position: [0, -0.5, -10], rotation: [0, 0, 0], scale: [40, 1, 60] },
      },
      // A wall a metre and a half behind the hostile, for the cases that need it to
      // stay put. Every profile steers toward its own preferred range the moment the
      // level loads, so an unpinned hostile drifts out of the blade's envelope inside
      // a second and the case ends up measuring the walk rather than the blade.
      ...(options.pin && bot ? [{
        id: 'backstop', kind: 'box' as const, color: '#334', collision: true, surface: 'no-traverse' as const,
        transform: { position: [0, 2, bot.position[2] - 1.5] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [40, 5, 1] as Vec3 },
      }] : []),
    ],
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 },
      ...(bot ? [{ id: 'guard', kind: bot.kind, position: bot.position, rotationY: 0 } as const] : []),
    ],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -200],
  };
}

async function start(level: LegacyLevelDocumentV1): Promise<FlowSimulation> {
  const simulation = new FlowSimulation();
  await simulation.loadLevel(cookLevel(level));
  // Just enough to settle the 0.1 m the capsule spawns above the floor. Kept short
  // on purpose: hostiles start steering toward their preferred range immediately, and
  // every settling tick is drift the range and arc cases would have to absorb.
  for (let tick = 1; tick <= 4; tick += 1) simulation.step(frame(tick), TICK);
  return simulation;
}

/** Eye-to-capsule-centre distance and off-axis angle to the one hostile, as measured. */
function bearing(output: ReturnType<FlowSimulation['step']>): { distance: number; angle: number } {
  const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot');
  if (!bot) return { distance: Infinity, angle: Infinity };
  const camera = output.snapshot.camera;
  const dx = bot.position[0] - camera.position[0];
  const dy = bot.position[1] - camera.position[1];
  const dz = bot.position[2] - camera.position[2];
  const distance = Math.hypot(dx, dy, dz);
  const forward = [-Math.sin(camera.yaw) * Math.cos(camera.pitch), Math.sin(camera.pitch), -Math.cos(camera.yaw) * Math.cos(camera.pitch)];
  const dot = (dx * forward[0] + dy * forward[1] + dz * forward[2]) / distance;
  return { distance, angle: Math.acos(Math.min(1, Math.max(-1, dot))) };
}

/** Holds the blade down for `ticks` and returns everything it produced. */
function hold(simulation: FlowSimulation, from: number, ticks: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let tick = from; tick < from + ticks; tick += 1) {
    events.push(...simulation.step(frame(tick, {
      held: Action.Slash,
      pressed: tick === from ? Action.Slash : 0,
    }), TICK).events);
  }
  return events;
}

describe('the blade is the primary verb', () => {
  it('swings on the left mouse button and lands on a hostile in reach', async () => {
    const simulation = await start(arena({ kind: 'bot-ranged', position: [0, 1, -2.5] }));
    const events = hold(simulation, 10, 1);

    const swing = events.find((event) => event.kind === 'melee');
    expect(swing).toBeDefined();
    expect(swing?.targetEntityId).toBe(2);
    const hit = events.find((event) => event.kind === 'hit' && event.targetEntityId === 2);
    expect(hit?.value).toBeCloseTo(melee.light.damage, 5);
    simulation.dispose();
  });

  it('kills a ranged hunter in two swings rather than chipping it', async () => {
    const simulation = await start(arena({ kind: 'bot-ranged', position: [0, 1, -2.5] }, { pin: true }));
    // One swing, then the recovery, then the second: the whole exchange is under half
    // a second, which is the difference between a verb and a chore.
    const first = hold(simulation, 10, SLASH_TICKS);
    expect(first.some((event) => event.kind === 'kill')).toBe(false);
    const second = hold(simulation, 10 + SLASH_TICKS, 1);
    expect(second.some((event) => event.kind === 'kill')).toBe(true);
    simulation.dispose();
  });

  it('swings again on its own once the recovery is up, without a second click', async () => {
    // No hostile at all, so nothing can end the sequence early.
    const simulation = await start(arena(null));
    const swings = hold(simulation, 10, SLASH_TICKS * 3).filter((event) => event.kind === 'melee');
    // Three windows held down is three swings, not one and not one per tick.
    expect(swings).toHaveLength(3);
    for (let index = 1; index < swings.length; index += 1) {
      expect(swings[index].tick - swings[index - 1].tick).toBe(SLASH_TICKS);
    }
    simulation.dispose();
  });

  it('reports a whiff rather than swallowing it', async () => {
    const simulation = await start(arena({ kind: 'bot-ranged', position: [0, 1, -12] }));
    const events = hold(simulation, 10, 1);
    const swing = events.find((event) => event.kind === 'melee');
    // The swing is still announced -- the mix needs it -- and it names no target.
    expect(swing).toBeDefined();
    expect(swing?.targetEntityId).toBeUndefined();
    expect(events.some((event) => event.kind === 'hit')).toBe(false);
    simulation.dispose();
  });

  it('reaches further than the old stub, and stops at the authored range', async () => {
    // A bulwark backs off toward its preferred range of six metres, which walks it
    // out through the edge of the blade's envelope, and its plate means the swings
    // cannot kill it on the way. So the boundary can be measured rather than assumed.
    const simulation = await start(arena({ kind: 'bot-bulwark', position: [0, 1, -2.6] }));
    let furthestHit = 0;
    let nearestMiss = Infinity;
    for (let tick = 5; tick <= 240; tick += 1) {
      const output = simulation.step(frame(tick, { held: Action.Slash, pressed: tick === 5 ? Action.Slash : 0 }), TICK);
      const swing = output.events.find((event) => event.kind === 'melee');
      if (!swing) continue;
      const { distance } = bearing(output);
      if (swing.targetEntityId === undefined) nearestMiss = Math.min(nearestMiss, distance);
      else furthestHit = Math.max(furthestHit, distance);
    }
    expect(furthestHit).toBeGreaterThan(2.25);
    expect(furthestHit).toBeLessThanOrEqual(melee.light.range);
    expect(nearestMiss).toBeGreaterThan(melee.light.range - 0.4);
    simulation.dispose();
  });

  it('sweeps an arc wide enough to catch a hostile off to the side', async () => {
    // Placed 55 degrees off the look direction at two and a half metres: outside the
    // 56.6-degree cone the melee stub used once the eye-height offset is counted, and
    // inside the blade's 65. The angle is measured rather than assumed, because a
    // hostile is already steering by the time the swing lands.
    const simulation = await start(arena({ kind: 'bot-bulwark', position: [2.5 * Math.sin(0.96), 1, -2.5 * Math.cos(0.96)] }));
    const output = simulation.step(frame(5, { held: Action.Slash, pressed: Action.Slash }), TICK);
    const { angle } = bearing(output);
    expect(angle).toBeGreaterThan(Math.acos(0.55));
    expect(angle).toBeLessThan(Math.acos(melee.light.arcCosine));
    expect(output.events.find((event) => event.kind === 'melee')?.targetEntityId).toBe(2);
    simulation.dispose();
  });

  it('refuses a hostile behind the player', async () => {
    const simulation = await start(arena({ kind: 'bot-ranged', position: [0, 1, 2.5] }));
    expect(hold(simulation, 10, 1).find((event) => event.kind === 'melee')?.targetEntityId).toBeUndefined();
    simulation.dispose();
  });

  it('cannot brute-force a bulwark through the plate', async () => {
    // Pinned against a wall, so it takes every swing head-on: the point under test is
    // the plate, not whether a sprint can keep up with it.
    const simulation = await start(arena({ kind: 'bot-bulwark', position: [0, 1, -2.5] }, { pin: true }));
    const events = hold(simulation, 5, SLASH_TICKS * 6);
    const deflected = events.filter((event) => event.kind === 'hit' && event.deflected);
    expect(deflected.length).toBeGreaterThan(2);
    // The plate answers the blade as well as the gun: six swings into it is a fraction
    // of its health, so the counter stays the movement kit.
    expect(deflected[0].value).toBeLessThan(melee.light.damage * 0.25);
    expect(events.some((event) => event.kind === 'kill')).toBe(false);
    simulation.dispose();
  });

  it('leaves the sidearm on its own button, unchanged', async () => {
    const simulation = await start(arena({ kind: 'bot-ranged', position: [0, 1, -2.5] }));
    // `Action.Fire` is the gun now, and it still spends a round and traces a shot.
    const output = simulation.step(frame(10, { held: Action.Fire, pressed: Action.Fire }), TICK);
    expect(output.events.some((event) => event.kind === 'shot')).toBe(true);
    expect(output.snapshot.player.ammo).toBe(output.snapshot.player.magazineSize - 1);
    // And the blade costs nothing from the magazine.
    hold(simulation, 20, 1);
    expect(simulation.step(frame(30), TICK).snapshot.player.ammo).toBe(output.snapshot.player.magazineSize - 1);
    simulation.dispose();
  });

  it('publishes the swing as an action with progress the viewmodel can read', async () => {
    const simulation = await start(arena(null));
    const swung = simulation.step(frame(10, { held: Action.Slash, pressed: Action.Slash }), TICK);
    expect(swung.snapshot.player.action).toBe('melee');
    // Timers are drained before the swing is offered, so the tick it starts on reads
    // zero progress and the recovery is measurable from there.
    expect(swung.snapshot.player.actionProgress).toBe(0);

    let output = swung;
    for (let tick = 11; tick < 10 + SLASH_TICKS; tick += 1) output = simulation.step(frame(tick), TICK);
    expect(output.snapshot.player.action).toBe('melee');
    expect(output.snapshot.player.actionProgress).toBeGreaterThan(0.9);
    output = simulation.step(frame(10 + SLASH_TICKS, {}), TICK);
    expect(output.snapshot.player.action).toBe('neutral');
    simulation.dispose();
  });

  it('keeps the brawler standoff inside the blade, so a closing enemy is reachable', async () => {
    // The invariant, stated as a number: the enemy built to close has to stop inside
    // the reach of the verb built to answer it. Measured before this was true, a
    // brawler standing off at five metres took zero of twenty-two swings and killed
    // the player, because a blade cannot reach what a rifle used to.
    expect(botProfiles.aggressive.preferredRange).toBeLessThan(melee.light.range - 1);

    // And in play: hold the blade, stand still, let it walk in.
    const simulation = await start(arena({ kind: 'bot-aggressive', position: [0, 1, -14] }));
    let landed = 0;
    let killed = 0;
    for (let tick = 5; tick <= 400 && killed === 0; tick += 1) {
      const output = simulation.step(frame(tick, { held: Action.Slash, pressed: tick === 5 ? Action.Slash : 0 }), TICK);
      for (const event of output.events) {
        if (event.kind === 'melee' && event.targetEntityId !== undefined) landed += 1;
        if (event.kind === 'kill') killed = tick;
      }
    }
    expect(landed).toBeGreaterThanOrEqual(2);
    // Two swings and about two seconds, most of which is the walk.
    expect((killed - 5) / 60).toBeLessThan(3);
    simulation.dispose();
  });

  it('leaves the ranged hunter out of reach, because that is what the sidearm is for', () => {
    // The other half of the same invariant. A hunter that stands off at eighteen
    // metres must stay a shooting problem; if the blade could reach it there would be
    // no reason to carry a gun at all.
    expect(botProfiles.ranged.preferredRange).toBeGreaterThan(melee.light.range * 3);
  });

  it('reaches across a gap wider than the two bodies standing in it', () => {
    // Reach is measured centre to centre, and 0.7 m of it is the two capsules'
    // radii -- so the number that matters to a player is what is left. Stated here
    // because shrinking either capsule would quietly shorten the blade.
    const bodies = playerCapsule.radius + botCapsule.radius;
    expect(melee.light.range - bodies).toBeGreaterThan(2.5);
  });

  it('sweeps every hostile in the arc, where the light takes only the nearest', async () => {
    // Three brawlers spread across the front, all inside the heavy's 160-degree arc.
    const level = arena(null);
    level.spawns.push(
      { id: 'a', kind: 'bot-aggressive', position: [-2.4, 1, -2.4], rotationY: 0 },
      { id: 'b', kind: 'bot-aggressive', position: [0, 1, -3], rotationY: 0 },
      { id: 'c', kind: 'bot-aggressive', position: [2.4, 1, -2.4], rotationY: 0 },
    );
    const simulation = await start(level);

    const light = simulation.step(frame(5, { held: Action.Slash, pressed: Action.Slash }), TICK);
    expect(light.events.filter((event) => event.kind === 'hit')).toHaveLength(1);
    // Let the light recover, then the heavy.
    for (let tick = 6; tick <= 5 + Math.ceil(melee.light.seconds * 60); tick += 1) simulation.step(frame(tick), TICK);
    const heavy = simulation.step(frame(6 + Math.ceil(melee.light.seconds * 60), { pressed: Action.Melee }), TICK);

    const struck = heavy.events.filter((event) => event.kind === 'hit');
    expect(struck).toHaveLength(3);
    // The swing itself reports how many it caught, and names the nearest for the HUD.
    const swing = heavy.events.find((event) => event.kind === 'melee')!;
    expect(swing.heavy).toBe(true);
    expect(swing.value).toBe(3);
    expect(swing.targetEntityId).toBeDefined();
    simulation.dispose();
  });

  it('costs nearly twice the recovery of a light, which is the whole price of it', async () => {
    const simulation = await start(arena(null));
    const heavy = simulation.step(frame(5, { pressed: Action.Melee }), TICK);
    expect(heavy.snapshot.player.action).toBe('melee');

    let recovering = 1;
    for (let tick = 6; tick <= 200; tick += 1) {
      if (simulation.step(frame(tick), TICK).snapshot.player.action !== 'melee') break;
      recovering += 1;
    }
    expect(Math.abs(recovering / 60 - melee.heavy.seconds)).toBeLessThanOrEqual(1 / 60);
    // Longer than a brawler's whole wind-up: throw it into a telegraph and the shot
    // lands on you, which is what makes it a commitment rather than a free upgrade.
    expect(melee.heavy.seconds).toBeGreaterThan(botProfiles.aggressive.windupSeconds);
    expect(melee.heavy.seconds).toBeGreaterThan(melee.light.seconds * 1.7);
    simulation.dispose();
  });

  it('gets through a plate where the light cannot, without making the plate pointless', async () => {
    const pinned = () => arena({ kind: 'bot-bulwark', position: [0, 1, -2.5] }, { pin: true });

    const lightRun = await start(pinned());
    const lightHit = hold(lightRun, 5, 1).find((event) => event.kind === 'hit')!;
    lightRun.dispose();

    const heavyRun = await start(pinned());
    const heavyHit = heavyRun.step(frame(5, { pressed: Action.Melee }), TICK).events.find((event) => event.kind === 'hit')!;
    heavyRun.dispose();

    // Both are still deflected -- the plate is not bypassed, it is only halved.
    expect(lightHit.deflected).toBe(true);
    expect(heavyHit.deflected).toBe(true);
    expect(heavyHit.value).toBeCloseTo(melee.heavy.damage * melee.heavy.shieldFloor, 5);
    // Six times the light gets through, for less than twice the recovery.
    expect(heavyHit.value! / lightHit.value!).toBeGreaterThan(5);
    // And flanking is still better than either: six carbine rounds to the flank do what
    // four rooted heavies do, so the movement kit stays the efficient answer.
    const heaviesToKill = Math.ceil(botProfiles.bulwark.health / (melee.heavy.damage * melee.heavy.shieldFloor));
    expect(heaviesToKill * melee.heavy.seconds).toBeGreaterThan(1.5);
  });

  it('reaches further and wider than the light', () => {
    // Stated as an invariant rather than measured, because it is the reason to press a
    // different button: the heavy is the swing for a crowd and for a guard.
    expect(melee.heavy.range).toBeGreaterThan(melee.light.range);
    expect(melee.heavy.arcCosine).toBeLessThan(melee.light.arcCosine);
    expect(melee.heavy.damage).toBeGreaterThan(melee.light.damage);
  });

  it('reproduces the same swings for the same input tape', async () => {
    const run = async (): Promise<number[]> => {
      const simulation = await start(arena({ kind: 'bot-aggressive', position: [0, 1, -3] }));
      const health: number[] = [];
      for (let tick = 10; tick <= 200; tick += 1) {
        const output = simulation.step(frame(tick, { held: Action.Slash | Action.Forward }), TICK);
        health.push(Math.round((output.snapshot.entities.find((entity) => entity.kind === 'bot')?.health ?? 0) * 100));
      }
      simulation.dispose();
      return health;
    };
    expect(await run()).toEqual(await run());
  });
});
