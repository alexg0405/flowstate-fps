import { describe, expect, it } from 'vitest';
import { Action, type GameEvent, type InputFrame, type LegacyLevelDocumentV1 } from '../src/contracts';
import { botProfiles, dodge, movementProfile } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

/** Flat arena with one ranged hunter ahead, which is the profile that telegraphs longest. */
function arena(): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'dodge',
    name: 'Dodge',
    units: 'meters',
    primitives: [{
      id: 'floor', kind: 'box', color: '#889', collision: true, surface: 'default',
      transform: { position: [0, -0.5, -20], rotation: [0, 0, 0], scale: [60, 1, 90] },
    }],
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 },
      { id: 'guard', kind: 'bot-ranged', position: [0, 1, -12], rotationY: 0 },
    ],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -300],
  };
}

async function start(): Promise<FlowSimulation> {
  const simulation = new FlowSimulation();
  await simulation.loadLevel(cookLevel(arena()));
  for (let tick = 1; tick <= 6; tick += 1) simulation.step(frame(tick), TICK);
  return simulation;
}

/**
 * Runs until a telegraph is heard, then dashes so the invulnerability frames are live
 * when the committed shot resolves. `windupSeconds` is what makes this possible: the
 * bot announces the shot and only then traces it.
 */
function dodgeTheNextShot(simulation: FlowSimulation, options: { dash: boolean } = { dash: true }): GameEvent[] {
  const collected: GameEvent[] = [];
  let telegraphTick = 0;
  for (let tick = 7; tick <= 1200; tick += 1) {
    const windup = telegraphTick > 0 ? (tick - telegraphTick) / 60 : 0;
    // Dash late in the wind-up, so the frames are still live when the trace resolves
    // rather than expired by the time it does.
    const dashNow = options.dash && telegraphTick > 0
      && windup >= botProfiles.ranged.windupSeconds - dodge.invulnerableSeconds * 0.6
      && windup < botProfiles.ranged.windupSeconds;
    const output = simulation.step(frame(tick, dashNow ? { pressed: Action.Dash } : {}), TICK);
    collected.push(...output.events);
    for (const event of output.events) {
      if (event.kind === 'enemyTelegraph' && telegraphTick === 0) telegraphTick = tick;
      if (event.kind === 'dodge' || (event.kind === 'hit' && event.targetEntityId === 1)) return collected;
    }
  }
  return collected;
}

describe('the dash is the defensive verb', () => {
  it('arms invulnerability frames on a dash, for the authored window', async () => {
    const simulation = await start();
    const dashed = simulation.step(frame(7, { pressed: Action.Dash }), TICK).snapshot.player;
    expect(dashed.dodge.invulnerable).toBe(true);
    expect(dashed.dodge.ready).toBe(false);

    let live = 1;
    for (let tick = 8; tick <= 130; tick += 1) {
      if (!simulation.step(frame(tick), TICK).snapshot.player.dodge.invulnerable) break;
      live += 1;
    }
    // Measured as a duration and allowed one frame of slack, because the window is not
    // a whole number of frames and the timer is drained before the snapshot is taken.
    expect(Math.abs(live / 60 - dodge.invulnerableSeconds)).toBeLessThanOrEqual(1 / 60);
    // Longer than the 0.16 s dash on purpose: judging a dash-length window off an
    // audio cue is a coin flip.
    expect(dodge.invulnerableSeconds).toBeGreaterThan(movementProfile.dashSeconds);
    simulation.dispose();
  });

  it('refuses a telegraphed shot that would have connected, and says so', async () => {
    const simulation = await start();
    const events = dodgeTheNextShot(simulation);
    const dodged = events.find((event) => event.kind === 'dodge');
    expect(dodged).toBeDefined();
    // The event carries what the round would have done, so the confirmation can name
    // the damage that did not happen.
    expect(dodged?.value).toBeCloseTo(botProfiles.ranged.damage, 5);
    expect(dodged?.targetEntityId).toBe(1);
    expect(dodged?.origin).toBeDefined();
    // And no damage arrived on that tick.
    expect(events.some((event) => event.kind === 'hit' && event.targetEntityId === 1 && event.tick === dodged!.tick)).toBe(false);
    simulation.dispose();
  });

  it('pays a chain link, so defending extends a combo instead of interrupting it', async () => {
    const simulation = await start();
    const events = dodgeTheNextShot(simulation);
    const dodged = events.find((event) => event.kind === 'dodge')!;
    const link = events.find((event) => event.kind === 'comboLink' && event.tick === dodged.tick);
    expect(link).toBeDefined();
    simulation.dispose();
  });

  it('takes the shot when the player is not dashing', async () => {
    // The control. Same bot, same telegraph, no dash.
    const simulation = await start();
    const events = dodgeTheNextShot(simulation, { dash: false });
    expect(events.some((event) => event.kind === 'dodge')).toBe(false);
    expect(events.some((event) => event.kind === 'hit' && event.targetEntityId === 1)).toBe(true);
    simulation.dispose();
  });

  it('cannot be farmed by dashing at nothing', async () => {
    // Dodging has to mean a round that was going to land did not, which is why the
    // check sits where the trace resolves rather than at the moment of the dash.
    const simulation = await start();
    let links = 0;
    let dodges = 0;
    for (let tick = 7; tick <= 400; tick += 1) {
      const output = simulation.step(frame(tick, { pressed: tick % 20 === 0 ? Action.Dash : 0 }), TICK);
      links += output.events.filter((event) => event.kind === 'comboLink').length;
      dodges += output.events.filter((event) => event.kind === 'dodge').length;
    }
    // Whatever the dashes were worth, they were not worth a dodge each.
    expect(dodges).toBeLessThan(links);
    simulation.dispose();
  });

  it('rations the frames without rationing the dash', async () => {
    const simulation = await start();
    // A ground dash has no cooldown of its own, so pressing it every tick is legal
    // movement and produces a dash as often as the air-charge economy allows. What
    // must not follow it is the invulnerability.
    let dashStarts = 0;
    let windowStarts = 0;
    let invulnerableFrames = 0;
    let dashing = false;
    let invulnerable = false;
    const total = 600;
    for (let tick = 7; tick < 7 + total; tick += 1) {
      const player = simulation.step(frame(tick, { pressed: Action.Dash }), TICK).snapshot.player;
      const nowDashing = player.locomotion === 'dashing';
      if (nowDashing && !dashing) dashStarts += 1;
      if (player.dodge.invulnerable && !invulnerable) windowStarts += 1;
      if (player.dodge.invulnerable) invulnerableFrames += 1;
      dashing = nowDashing;
      invulnerable = player.dodge.invulnerable;
    }
    // Dashes outnumber defended dashes by half again, so the gate is doing real work.
    expect(dashStarts).toBeGreaterThan(windowStarts * 1.5);
    // And the hard ceiling on uptime is the window over the window plus the gap, which
    // a spammed dash cannot exceed however often it fires.
    const ceiling = dodge.invulnerableSeconds / (dodge.invulnerableSeconds + dodge.cooldownSeconds);
    expect(invulnerableFrames / total).toBeLessThan(ceiling + 0.02);
    // The defence is still there, though -- rationed, not removed.
    expect(windowStarts).toBeGreaterThanOrEqual(3);
    simulation.dispose();
  });

  it('clears the frames and the gate on a checkpoint restore', async () => {
    const simulation = await start();
    simulation.step(frame(7, { pressed: Action.Dash }), TICK);
    expect(simulation.step(frame(8), TICK).snapshot.player.dodge.invulnerable).toBe(true);
    simulation.restoreCheckpoint();
    const restored = simulation.step(frame(9), TICK).snapshot.player;
    // A restore must not hand the player invulnerability they did not earn, nor keep
    // them locked out of it.
    expect(restored.dodge.invulnerable).toBe(false);
    expect(restored.dodge.ready).toBe(true);
    simulation.dispose();
  });

  it('reproduces the same dodges for the same input tape', async () => {
    const run = async (): Promise<string[]> => {
      const simulation = await start();
      const log: string[] = [];
      for (let tick = 7; tick <= 600; tick += 1) {
        const output = simulation.step(frame(tick, { pressed: tick % 37 === 0 ? Action.Dash : 0 }), TICK);
        for (const event of output.events) {
          if (event.kind === 'dodge' || event.kind === 'hit') log.push(`${event.tick} ${event.kind} ${Math.round(event.value ?? 0)}`);
        }
      }
      simulation.dispose();
      return log;
    };
    expect(await run()).toEqual(await run());
  });
});
