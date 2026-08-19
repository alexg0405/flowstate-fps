import type { LevelDocumentV2 } from '../contracts';

export interface NavigationBake {
  data: Uint8Array;
  sourceKey: string;
}

/** Stable identity for exactly the authored data consumed by navmesh.worker. */
export function navigationSourceKey(document: Pick<LevelDocumentV2, 'collision' | 'offMeshLinks'>): string {
  return JSON.stringify({ collision: document.collision, offMeshLinks: document.offMeshLinks });
}

export function currentNavigationData(bake: NavigationBake | undefined, sourceKey: string): Uint8Array | undefined {
  return bake?.sourceKey === sourceKey ? bake.data : undefined;
}
