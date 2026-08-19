import rawCatalog from './surfaceTextures.json';

export type SurfaceTextureId = keyof typeof rawCatalog.entries;

export interface SurfaceTextureDefinition {
  uri: string;
  hash: `sha256:${string}`;
  byteLength: number;
  gpuBytes: number;
}

export const surfaceTextureEntries = Object.freeze(
  Object.fromEntries(Object.entries(rawCatalog.entries).map(([id, entry]) => [id, Object.freeze(entry)])),
) as Readonly<Record<SurfaceTextureId, SurfaceTextureDefinition>>;

export const surfaceTextureMemoryEstimate = Object.freeze({
  cpuBytes: Object.values(surfaceTextureEntries).reduce((total, entry) => total + entry.byteLength, 0),
  gpuBytes: Object.values(surfaceTextureEntries).reduce((total, entry) => total + entry.gpuBytes, 0),
});
