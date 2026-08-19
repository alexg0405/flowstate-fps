import { describe, expect, it } from 'vitest';
import type { LegacyLevelDocumentV1, LevelPrimitive } from '../src/contracts';
import { defaultLevel } from '../src/content/defaultLevel';
import { migrateLevelDocument } from '../src/content/migrations';
import { levelDocumentSchema, validateLevel } from '../src/content/schema';

function legacyLevel(): LegacyLevelDocumentV1 {
  const primitives: LevelPrimitive[] = defaultLevel.collision.map(({ traversal: _traversal, nav: _nav, ...primitive }) => primitive);
  return {
    schemaVersion: 1,
    id: defaultLevel.id,
    name: defaultLevel.name,
    units: defaultLevel.units,
    primitives,
    spawns: structuredClone(defaultLevel.spawns),
    encounters: structuredClone(defaultLevel.encounters),
    offMeshLinks: structuredClone(defaultLevel.offMeshLinks),
    exit: structuredClone(defaultLevel.exit),
  };
}

describe('level validation and migration', () => {
  it('accepts the built-in V2 vertical slice', () => {
    expect(defaultLevel.schemaVersion).toBe(2);
    expect(defaultLevel.primitives).toBe(defaultLevel.collision);
    expect(defaultLevel.environmentPresetId).toBeTruthy();
    expect(defaultLevel.assetCatalogVersion).toBeTruthy();
    expect(validateLevel(defaultLevel)).toEqual({ errors: [], warnings: [] });
  });

  it('losslessly migrates V1 gameplay content and adds explicit traversal metadata', () => {
    const legacy = legacyLevel();
    const source = structuredClone(legacy);
    const migrated = migrateLevelDocument(legacy);

    expect(legacy).toEqual(source);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.primitives).toBe(migrated.collision);
    expect(migrated.visuals).toEqual([]);
    expect(migrated.lights).toEqual([]);
    expect(migrated.spawns).toEqual(legacy.spawns);
    expect(migrated.encounters).toEqual(legacy.encounters);
    expect(migrated.offMeshLinks).toEqual(legacy.offMeshLinks);
    expect(migrated.exit).toEqual(legacy.exit);
    expect(migrated.collision.map(({ traversal: _traversal, nav: _nav, ...primitive }) => primitive)).toEqual(legacy.primitives);
    expect(migrated.collision.find((item) => item.surface === 'wall-run')?.traversal.wallRun).toBe(true);
    expect(migrated.collision.find((item) => item.surface === 'no-traverse')?.nav.walkable).toBe(false);
    expect(migrated.collision.find((item) => item.id === 'grapple-overhead-a')?.traversal.grapple).toBe(true);
  });

  it('normalizes V1 imports to V2 and preserves the compatibility alias', () => {
    const parsed = levelDocumentSchema.parse(legacyLevel());
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.primitives).toBe(parsed.collision);
    expect(parsed.collision).toHaveLength(defaultLevel.collision.length);
  });

  it('rejects duplicate IDs and missing encounter references across V2 records', () => {
    const level = structuredClone(defaultLevel);
    level.spawns[1].id = level.collision[0].id;
    level.encounters[0].requiredBotIds = ['missing-bot'];
    level.visuals.push({
      id: 'unbound-prop',
      assetId: 'props.unbound',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      castShadow: true,
      receiveShadow: true,
      collisionAlignmentId: 'missing-collision',
    });
    const result = validateLevel(level);
    expect(result.errors).toContain(`Duplicate id: ${level.collision[0].id}`);
    expect(result.errors.some((message) => message.includes('missing-bot'))).toBe(true);
    expect(result.errors).toContain('Visual unbound-prop references missing collision missing-collision.');
    expect(result.errors).toContain('Visual unbound-prop references unknown catalog asset props.unbound.');
  });

  it('fails incompatible art catalogs and environment presets with explicit diagnostics', () => {
    const level = structuredClone(defaultLevel);
    level.assetCatalogVersion = 'future-v99';
    level.environmentPresetId = 'unknown-sky';
    const result = validateLevel(level);
    expect(result.errors).toContain('Unsupported asset catalog version future-v99; expected core-v1.');
    expect(result.errors).toContain('Unsupported environment preset unknown-sky; expected cyber-dusk-v1.');
  });

  it('normalizes deprecated gate bindings without emitting legacy visual fields', () => {
    const serialized = structuredClone(defaultLevel) as unknown as Record<string, unknown>;
    serialized.visuals = [{
      id: 'gate-sign',
      assetId: 'sign.gate',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      castShadow: false,
      receiveShadow: false,
      gateForEncounterId: 'arena-1',
    }];
    const parsed = levelDocumentSchema.parse(serialized);
    expect(parsed.visuals[0].gateVisibilityBindingId).toBe('arena-1');
    expect(parsed.visuals[0]).not.toHaveProperty('gateForEncounterId');
  });
});
