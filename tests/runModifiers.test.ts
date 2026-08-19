import { describe, expect, it } from 'vitest';
import { Action, type InputFrame, type LegacyLevelDocumentV1, type RunModifier } from '../src/contracts';
import { botProfiles } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { chassisMultiplier, getRunModifier, modifierForDate, runModifiers } from '../src/content/modifiers';
import { defaultBuildFor } from '../src/content/weapons';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

function arena(): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'modifier-arena',
    name: 'Modifier Arena',
    units: 'meters',
    primitives: [{
      id: 'floor', kind: 'box', color: '#fff', collision: true, surface: 'default',
      transform: { position: [0, -0.5, -20], rotation: [0, 0, 0], scale: [40, 1, 80] },
    }],
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 },
      { id: 'guard', kind: 'bot-ranged', position: [0, 1, -8], rotationY: 0 },
    ],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -200],
  };
}

describe('the daily contract', () => {
  it('gives every player the same rules on the same day', () => {
    const morning = modifierForDate(new Date(2026, 7, 19, 6, 0, 0));
    const evening = modifierForDate(new Date(2026, 7, 19, 23, 30, 0));
    expect(morning.id).toBe(evening.id);
  });

  it('turns over between days', () => {
    // Not every consecutive pair need differ, but a fortnight must not be one contract.
    const ids = new Set<string>();
    for (let day = 1; day <= 14; day += 1) ids.add(modifierForDate(new Date(2026, 0, day)).id);
    expect(ids.size).toBeGreaterThan(1);
  });

  it('only ever selects a defined contract', () => {
    for (let day = 0; day < 60; day += 1) {
      const modifier = modifierForDate(new Date(2026, 3, 1 + day));
      expect(getRunModifier(modifier.id)).toBe(modifier);
    }
  });

  it('never makes a run worth less than an unmodified one', () => {
    for (const modifier of runModifiers) {
      expect(modifier.chassisBonus).toBeGreaterThanOrEqual(0);
      expect(modifier.linkBonus).toBeGreaterThanOrEqual(0);
      expect(modifier.runBonus ?? 0).toBeGreaterThanOrEqual(0);
    }
  });

  it('pays a bonus only for the chassis it favours', () => {
    const closeQuarters = getRunModifier('close-quarters')!;
    expect(chassisMultiplier(closeQuarters, 'shotgun')).toBe(1 + closeQuarters.chassisBonus);
    expect(chassisMultiplier(closeQuarters, 'dmr')).toBe(1);
    expect(chassisMultiplier(null, 'shotgun')).toBe(1);
  });
});

describe('applying a contract to a run', () => {
  const glass: RunModifier = {
    id: 'test-glass', label: 'Test Glass', description: '',
    favouredChassis: [], chassisBonus: 0, linkBonus: 0, runBonus: 1,
    enemy: { damage: 2 },
  };

  it('scales what a kill is worth', async () => {
    const carbine = defaultBuildFor('carbine', 'c', 'Carbine');
    const kills = async (modifier: RunModifier | null): Promise<number> => {
      const simulation = new FlowSimulation(undefined, [carbine, carbine], modifier);
      await simulation.loadLevel(cookLevel(arena()));
      let output = simulation.step(frame(1), TICK);
      for (let tick = 2; tick < 600; tick += 1) {
        const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot');
        if (!bot) break;
        const camera = output.snapshot.camera;
        const dx = bot.position[0] - camera.position[0];
        const dy = bot.position[1] + 0.3 - camera.position[1];
        const dz = bot.position[2] - camera.position[2];
        output = simulation.step(frame(tick, {
          held: Action.Fire,
          pressed: tick === 2 ? Action.Fire : 0,
          look: [
            (camera.yaw - Math.atan2(-dx, -dz)) / 0.002,
            (camera.pitch - Math.atan2(dy, Math.hypot(dx, dz))) / 0.002,
          ],
        }), TICK);
      }
      const score = output.snapshot.player.score;
      simulation.dispose();
      return score;
    };

    const plain = await kills(null);
    const doubled = await kills(glass);
    expect(plain).toBeGreaterThan(0);
    // `runBonus: 1` doubles the multiplier every award goes through.
    expect(doubled).toBeGreaterThan(plain);
  });

  it('bends the authored bot profile without replacing it', async () => {
    const simulation = new FlowSimulation(undefined, undefined, glass);
    await simulation.loadLevel(cookLevel(arena()));

    // Run until the guard's first shot lands, then read the damage it did.
    let output = simulation.step(frame(1), TICK);
    let taken = 0;
    for (let tick = 2; tick < 400 && taken === 0; tick += 1) {
      output = simulation.step(frame(tick), TICK);
      const hit = output.events.find((event) => event.kind === 'hit' && event.targetEntityId === 1);
      if (hit) taken = hit.value ?? 0;
    }
    expect(taken).toBe(botProfiles.ranged.damage * 2);
    simulation.dispose();
  });

  it('leaves the profile alone with no contract', async () => {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(arena()));
    let taken = 0;
    for (let tick = 1; tick < 400 && taken === 0; tick += 1) {
      const output = simulation.step(frame(tick), TICK);
      const hit = output.events.find((event) => event.kind === 'hit' && event.targetEntityId === 1);
      if (hit) taken = hit.value ?? 0;
    }
    expect(taken).toBe(botProfiles.ranged.damage);
    simulation.dispose();
  });
});
