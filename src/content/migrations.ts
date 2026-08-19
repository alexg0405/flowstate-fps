import type {
  CollisionPrimitiveV2,
  LegacyLevelDocumentV1,
  LevelDocument,
  LevelDocumentV2,
  LevelPrimitive,
  NavigationFlags,
  SurfaceTag,
  TraversalFlags,
} from '../contracts';

export const DEFAULT_ENVIRONMENT_PRESET_ID = 'cyber-dusk-v1';
export const DEFAULT_ASSET_CATALOG_VERSION = 'core-v1';

export function traversalFlagsFor(surface: SurfaceTag, collision: boolean): TraversalFlags {
  return {
    wallRun: collision && surface === 'wall-run',
    vault: collision && surface === 'vault',
    mantle: collision && surface === 'mantle',
    // V1 allowed the grapple ray to attach to every static collider, including
    // no-traverse overhead anchors. Preserve that behavior during migration.
    grapple: collision,
  };
}

export function navigationFlagsFor(surface: SurfaceTag, collision: boolean): NavigationFlags {
  return {
    includeInBake: collision,
    walkable: collision && surface !== 'no-traverse',
  };
}

export function migratePrimitive(primitive: LevelPrimitive): CollisionPrimitiveV2 {
  return {
    ...structuredClone(primitive),
    traversal: traversalFlagsFor(primitive.surface, primitive.collision),
    nav: navigationFlagsFor(primitive.surface, primitive.collision),
  };
}

/**
 * Normalizes either serialized generation into V2 without mutating the source.
 * `primitives` intentionally aliases `collision` in memory until all V1 runtime
 * consumers have moved to the canonical V2 property.
 */
export function migrateLevelDocument(level: LevelDocument): LevelDocumentV2 {
  if (level.schemaVersion === 2) {
    const clone = structuredClone(level);
    const collision = clone.collision;
    return { ...clone, collision, primitives: collision };
  }

  const legacy = structuredClone(level satisfies LegacyLevelDocumentV1);
  const collision = legacy.primitives.map(migratePrimitive);
  return {
    schemaVersion: 2,
    id: legacy.id,
    name: legacy.name,
    units: legacy.units,
    collision,
    visuals: [],
    lights: [],
    environmentPresetId: DEFAULT_ENVIRONMENT_PRESET_ID,
    assetCatalogVersion: DEFAULT_ASSET_CATALOG_VERSION,
    primitives: collision,
    spawns: legacy.spawns,
    encounters: legacy.encounters,
    offMeshLinks: legacy.offMeshLinks,
    exit: legacy.exit,
  };
}
