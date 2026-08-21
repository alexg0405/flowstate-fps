import { describe, expect, it } from 'vitest';
import { Action, type InputFrame, type LegacyLevelDocumentV1, type BladeStyleId } from '../src/contracts';
import { bladeStyle, bladeStyles, defaultBladeStyle, isBladeStyleId } from '../src/content/blades';
import { botProfiles, comboScoring } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

/** One hostile in reach, pinned so a swing keeps connecting. */
function arena(): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'blades',
    name: 'Blades',
    units: 'meters',
    primitives: [
      {
        id: 'floor', kind: 'box', color: '#889', collision: true, surface: 'default',
        transform: { position: [0, -0.5, -10], rotation: [0, 0, 0], scale: [30, 1, 40] },
      },
      {
        id: 'backstop', kind: 'box', color: '#334', collision: true, surface: 'no-traverse',
        transform: { position: [0, 2, -4], rotation: [0, 0, 0], scale: [30, 5, 1] },
      },
    ],
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 },
      { id: 'guard', kind: 'bot-ranged', position: [0, 1, -2.5], rotationY: 0 },
    ],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -200],
  };
}

async function start(blade: BladeStyleId): Promise<FlowSimulation> {
  const simulation = new FlowSimulation(undefined, undefined, null, blade);
  await simulation.loadLevel(cookLevel(arena()));
  for (let tick = 1; tick <= 4; tick += 1) simulation.step(frame(tick), TICK);
  return simulation;
}

describe('the blade is chosen, not assembled', () => {
  it('offers styles that differ in what they do to the chain, not only in damage', () => {
    // The point of the repoint. If two styles agree on every chain field then one of them
    // is a stat tweak wearing a style's clothes, and the bench is back to being a stat
    // game for a verb that should not be one.
    const behaviours = bladeStyles.map((style) => JSON.stringify(style.chain));
    expect(new Set(behaviours).size).toBe(bladeStyles.length);
    expect(bladeStyles.length).toBeGreaterThanOrEqual(3);
    for (const style of bladeStyles) {
      expect(style.chainNote.length, `${style.id} must say what it does to the chain`).toBeGreaterThan(20);
    }
  });

  it('keeps every style inside the envelope first-person melee needs', () => {
    for (const style of bladeStyles) {
      // Reach is the thing that stops the depth problem coming back. Three metres is the
      // floor: the two capsule radii are 0.7 m of it, so anything shorter is asking the
      // player to judge two metres of empty space with no arm on screen.
      expect(style.light.range, `${style.id} light reach`).toBeGreaterThan(3);
      expect(style.heavy.range, `${style.id} heavy reach`).toBeGreaterThan(style.light.range);
      // The heavy sweeps wider than the light, on every style.
      expect(style.heavy.arcCosine).toBeLessThan(style.light.arcCosine);
      // Two lights still kill a hundred-health hunter.
      expect(style.light.damage * 2).toBeGreaterThanOrEqual(botProfiles.ranged.health);
      // And no style may turn the bulwark into a damage problem: four committed heavies
      // through the plate is the fastest any of them may be.
      const throughPlate = style.heavy.damage * style.heavy.shieldFloor;
      expect(Math.ceil(botProfiles.bulwark.health / throughPlate)).toBeGreaterThanOrEqual(3);
    }
  });

  it('pays two links a kill on Cleave and one on Tempo', async () => {
    const linksForKill = async (blade: BladeStyleId): Promise<number> => {
      const simulation = await start(blade);
      let links = 0;
      for (let tick = 5; tick <= 200; tick += 1) {
        const output = simulation.step(frame(tick, { held: Action.Attack, pressed: tick === 5 ? Action.Attack : 0 }), TICK);
        const killed = output.events.some((event) => event.kind === 'kill');
        if (killed) {
          links = output.snapshot.player.combo.links;
          break;
        }
      }
      simulation.dispose();
      return links;
    };
    // A kill is the only repeatable link in the game, so doubling it is the only way to
    // grow a chain without reaching for a different tool.
    const tempo = await linksForKill('tempo');
    const cleave = await linksForKill('cleave');
    // Both open with a slash link, so the whole difference is what the kill paid.
    expect(cleave - tempo).toBe(bladeStyle('cleave').chain.killLinks - bladeStyle('tempo').chain.killLinks);
    expect(cleave).toBeGreaterThan(tempo);
  });

  it('holds a chain open longer on Tempo than on Cleave', async () => {
    const windowTicks = async (blade: BladeStyleId): Promise<number> => {
      const simulation = await start(blade);
      let opened = 0;
      let broke = 0;
      for (let tick = 5; tick <= 900; tick += 1) {
        const output = simulation.step(frame(tick, {
          held: tick === 5 ? Action.Attack : 0,
          pressed: tick === 5 ? Action.Attack : 0,
        }), TICK);
        if (!opened && output.events.some((event) => event.kind === 'comboLink')) opened = tick;
        if (opened && output.events.some((event) => event.kind === 'comboBreak')) {
          broke = tick;
          break;
        }
      }
      simulation.dispose();
      return broke - opened;
    };
    const tempo = await windowTicks('tempo');
    const cleave = await windowTicks('cleave');
    expect(tempo).toBeGreaterThan(cleave);
    // And the difference is the authored bonus, within a tick of rounding.
    const expected = bladeStyle('tempo').chain.windowBonusSeconds - bladeStyle('cleave').chain.windowBonusSeconds;
    expect(Math.abs((tempo - cleave) / 60 - expected)).toBeLessThan(2 / 60);
  });

  it('makes each link worth more on Riposte', async () => {
    const multiplier = async (blade: BladeStyleId): Promise<number> => {
      const simulation = await start(blade);
      const player = (simulation as unknown as { player: { comboLinks: number; comboTimer: number } }).player;
      player.comboLinks = 5;
      player.comboTimer = 9;
      const value = simulation.step(frame(5), TICK).snapshot.player.combo.multiplier;
      simulation.dispose();
      return value;
    };
    const tempo = await multiplier('tempo');
    const riposte = await multiplier('riposte');
    expect(riposte).toBeGreaterThan(tempo);
    expect(riposte).toBeCloseTo(1 + 5 * (comboScoring.linkStep + bladeStyle('riposte').chain.linkStepBonus), 6);
  });

  it('swings at the style\'s own rate', async () => {
    const recovery = async (blade: BladeStyleId): Promise<number> => {
      const simulation = await start(blade);
      let ticks = 1;
      simulation.step(frame(5, { held: Action.Attack, pressed: Action.Attack }), TICK);
      for (let tick = 6; tick <= 200; tick += 1) {
        if (simulation.step(frame(tick), TICK).snapshot.player.action !== 'melee') break;
        ticks += 1;
      }
      simulation.dispose();
      return ticks;
    };
    // Riposte is the quick blade and Cleave the slow one, and the simulation reads those
    // numbers off the carried style rather than off a constant.
    const riposte = await recovery('riposte');
    const cleave = await recovery('cleave');
    expect(riposte).toBeLessThan(cleave);
    expect(Math.abs(riposte / 60 - bladeStyle('riposte').light.seconds)).toBeLessThanOrEqual(1 / 60);
    expect(Math.abs(cleave / 60 - bladeStyle('cleave').light.seconds)).toBeLessThanOrEqual(1 / 60);
  });

  it('falls back to the reference style rather than breaking on a stale save', () => {
    expect(bladeStyle(undefined).id).toBe(defaultBladeStyle);
    expect(bladeStyle('a-style-that-was-removed').id).toBe(defaultBladeStyle);
    expect(isBladeStyleId('tempo')).toBe(true);
    expect(isBladeStyleId('nonsense')).toBe(false);
    expect(isBladeStyleId(undefined)).toBe(false);
  });

  it('reproduces the same run for the same style and tape', async () => {
    const run = async (): Promise<number[]> => {
      const simulation = await start('riposte');
      const links: number[] = [];
      for (let tick = 5; tick <= 300; tick += 1) {
        links.push(simulation.step(frame(tick, { held: Action.Attack }), TICK).snapshot.player.combo.links);
      }
      simulation.dispose();
      return links;
    };
    expect(await run()).toEqual(await run());
  });
});
