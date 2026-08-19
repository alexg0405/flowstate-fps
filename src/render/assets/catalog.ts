import rawCatalog from './catalog.json';
import type { AssetCatalog, AssetDefinition, AssetId, AssetKind, AssetPreloadGroup } from './types';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const assetEntries = deepFreeze(
  rawCatalog.entries as unknown as Record<AssetId, AssetDefinition>,
);

export const assetCatalog: AssetCatalog = deepFreeze({
  schemaVersion: 1,
  entries: assetEntries,
});

export function isAssetId(value: string): value is AssetId {
  return Object.prototype.hasOwnProperty.call(assetEntries, value);
}

export function getAssetDefinition(id: AssetId): AssetDefinition {
  return assetEntries[id];
}

export function listAssetIds(kind?: AssetKind): AssetId[] {
  return (Object.keys(assetEntries) as AssetId[]).filter((id) => !kind || assetEntries[id].kind === kind);
}

export function listPreloadGroup(group: AssetPreloadGroup): AssetId[] {
  return (Object.keys(assetEntries) as AssetId[]).filter((id) => assetEntries[id].preloadGroup === group);
}
