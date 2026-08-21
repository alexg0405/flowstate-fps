import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSave, runScoring } from '../src/content/config';
import type { LegacySaveDataV1, SaveDataV5 } from '../src/contracts';
import { loadSave, migrateSaveData, rankRun, recordRun, writeSave } from '../src/persistence/saveStore';

describe('local run records', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the best run whole and tracks the fastest clear separately', () => {
    recordRun(defaultSave, 120, 500, 0);
    const second = recordRun(loadSave(), 140, 800, 2);
    const save = loadSave();
    expect(save.schemaVersion).toBe(5);
    // The higher-scoring run owns the record, and every stat on it is that run's.
    expect(save.bestRun).toMatchObject({ timeSeconds: 140, score: 800, deaths: 2 });
    // The faster run is still tracked, but it is not folded into the record.
    expect(save.bestTimeSeconds).toBe(120);
    expect(second.isBestRun).toBe(true);
    expect(second.isFastest).toBe(false);
    expect(second.previousBest).toMatchObject({ timeSeconds: 120, score: 500 });
  });

  it('keeps the standing record when a later run scores lower', () => {
    recordRun(defaultSave, 100, 900, 0);
    const worse = recordRun(loadSave(), 200, 400, 4);
    expect(worse.isBestRun).toBe(false);
    expect(loadSave().bestRun).toMatchObject({ score: 900, timeSeconds: 100 });
  });

  it('grades on par time, deaths and chain rather than handing every clear an S', () => {
    const [top] = runScoring.ranks;
    // Every clear scores at least 1050 against the old S threshold of 900, so the
    // previous curve could only ever return S.
    expect(rankRun(runScoring.parSeconds, 0, top.minPeakCombo)).toBe('S');
    expect(rankRun(runScoring.parSeconds, 1, top.minPeakCombo)).toBe('A');
    expect(rankRun(runScoring.parSeconds * 1.25, 1, top.minPeakCombo)).toBe('A');
    expect(rankRun(runScoring.parSeconds * 1.5, 3, 4)).toBe('B');
    expect(rankRun(runScoring.parSeconds * 1.5, 4, 4)).toBe('C');
    expect(rankRun(runScoring.parSeconds * 4, 0, 20)).toBe('C');
  });

  it('refuses the top grades to a run that never chained anything', () => {
    // A clean, fast walkthrough of the route is no longer an S: the chain gate is
    // what makes the top grade mean the movement kit was actually used.
    expect(rankRun(runScoring.parSeconds * 0.5, 0, 0)).toBe('B');
    expect(rankRun(runScoring.parSeconds * 0.5, 0, 4)).toBe('A');
    expect(rankRun(runScoring.parSeconds * 0.5, 0, 8)).toBe('S');
  });

  it('round-trips a record with its splits', () => {
    const splits = [
      { encounterId: 'arena-1', label: 'Atrium', seconds: 30.5 },
      { encounterId: 'arena-2', label: 'Gallery', seconds: 71.25 },
    ];
    recordRun(defaultSave, 110, 1200, 1, splits, 14);
    expect(loadSave().bestRun?.splits).toEqual(splits);
    expect(loadSave().bestRun?.peakCombo).toBe(14);
  });

  it('round-trips accessibility and graphics settings', () => {
    const changed: SaveDataV5 = {
      ...migrateSaveData(defaultSave),
      settings: {
        ...migrateSaveData(defaultSave).settings,
        headBob: 0,
        cameraRoll: 0,
        shake: 0,
        fov: 105,
        reducedMotion: true,
        graphicsQuality: 'high',
        dynamicResolution: false,
      },
    };
    writeSave(changed);
    expect(loadSave().settings).toMatchObject({
      headBob: 0,
      cameraRoll: 0,
      shake: 0,
      fov: 105,
      reducedMotion: true,
      graphicsQuality: 'high',
      dynamicResolution: false,
    });
  });

  it('migrates V1 saves without losing records or established settings', () => {
    const legacy: LegacySaveDataV1 = {
      schemaVersion: 1,
      settings: {
        sensitivity: 0.003,
        fov: 104,
        cameraRoll: 0.25,
        headBob: 0,
        shake: 0.1,
        renderScale: 0.8,
        debug: true,
        reducedMotion: true,
      },
      bestTimeSeconds: 82.5,
      bestScore: 910,
      rank: 'S',
    };
    localStorage.setItem('flowstate-fps-save-v1', JSON.stringify(legacy));

    const migrated = loadSave();
    expect(migrated).toMatchObject({
      schemaVersion: 5,
      bestTimeSeconds: 82.5,
      // A legacy save's three independent fields are reconstructed as one record,
      // which is the closest honest reading of data that never described one run.
      bestRun: { timeSeconds: 82.5, score: 910, rank: 'S', deaths: 0 },
      settings: {
        sensitivity: 0.003,
        fov: 104,
        reducedMotion: true,
        graphicsQuality: 'auto',
        dynamicResolution: true,
      },
    });
  });

  it('supplies missing V1 accessibility and graphics defaults', () => {
    localStorage.setItem('flowstate-fps-save-v1', JSON.stringify({
      ...defaultSave,
      settings: { sensitivity: 0.002, fov: 92, cameraRoll: 1, headBob: 1, shake: 1, renderScale: 1, debug: false },
    }));
    const settings = loadSave().settings;
    expect(typeof settings.reducedMotion).toBe('boolean');
    expect(settings.graphicsQuality).toBe('auto');
    expect(settings.dynamicResolution).toBe(true);
  });
});

describe('armory persistence', () => {
  beforeEach(() => localStorage.clear());

  it('seeds two builds and a matching loadout for a fresh save', () => {
    const save = loadSave();
    expect(save.armory.length).toBeGreaterThanOrEqual(2);
    expect(save.loadout).toHaveLength(2);
    for (const id of save.loadout) expect(save.armory.some((build) => build.id === id)).toBe(true);
  });

  it('gives a legacy save the seeded armory rather than an empty one', () => {
    localStorage.setItem('flowstate-fps-save-v1', JSON.stringify({
      schemaVersion: 1, settings: { fov: 100 }, bestTimeSeconds: 70, bestScore: 400, rank: 'B',
    }));
    const migrated = loadSave();
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.armory.length).toBeGreaterThanOrEqual(2);
    expect(migrated.bestTimeSeconds).toBe(70);
    expect(migrated.bestRun).toMatchObject({ score: 400, rank: 'B' });
  });

  it('round-trips a custom build and its loadout', () => {
    const custom = {
      id: 'build-custom',
      name: 'Sniper',
      chassisId: 'dmr' as const,
      parts: { optic: 'optic.scope', barrel: 'barrel.long' },
    };
    writeSave({ ...loadSave(), armory: [custom], loadout: ['build-custom', 'build-custom'] });
    const reloaded = loadSave();
    expect(reloaded.armory).toEqual([custom]);
    expect(reloaded.loadout).toEqual(['build-custom', 'build-custom']);
  });

  it('drops parts and chassis that no longer exist instead of failing the load', () => {
    writeSave({
      ...loadSave(),
      armory: [
        { id: 'ok', name: 'Fine', chassisId: 'smg', parts: { optic: 'optic.reflex', barrel: 'barrel.removed' } },
        { id: 'bad', name: 'Gone', chassisId: 'plasma' as never, parts: {} },
      ],
      loadout: ['ok', 'missing'],
    });
    const reloaded = loadSave();
    expect(reloaded.armory.map((build) => build.id)).toEqual(['ok']);
    expect(reloaded.armory[0].parts).toEqual({ optic: 'optic.reflex' });
    // An unresolvable loadout entry falls back to a build that does exist.
    expect(reloaded.loadout.every((id) => reloaded.armory.some((build) => build.id === id))).toBe(true);
  });
});
