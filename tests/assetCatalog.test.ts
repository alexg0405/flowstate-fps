import { describe, expect, it } from 'vitest';
import {
  assetCatalog,
  getAssetDefinition,
  isAssetId,
  listAssetIds,
  listPreloadGroup,
  surfaceTextureEntries,
  surfaceTextureMemoryEstimate,
  type AssetId,
} from '../src/render/assets';
import { createFallbackAsset } from '../src/render/assets/fallbacks';

const EXPECTED_IDS: AssetId[] = [
  'viewmodel.runner-rifle',
  'character.hunter-ranged',
  'character.hunter-aggressive',
  'environment.rooftop-platform',
  'environment.wallrun-panel',
  'environment.vault-barrier',
  'environment.grapple-anchor',
  'environment.route-sign',
];

describe('curated asset catalog', () => {
  it('exposes stable IDs and typed metadata', () => {
    expect(Object.keys(assetCatalog.entries)).toEqual(EXPECTED_IDS);
    expect(listAssetIds('character')).toEqual(['character.hunter-ranged', 'character.hunter-aggressive']);
    expect(isAssetId('environment.grapple-anchor')).toBe(true);
    expect(isAssetId('environment.not-real')).toBe(false);
    expect(getAssetDefinition('viewmodel.runner-rifle').clips.fire01).toBe('vm_fire_01');
    expect(getAssetDefinition('viewmodel.runner-rifle').clips.grappleHold).toBe('vm_grapple_hold');
    expect(listPreloadGroup('combat')).toEqual(['character.hunter-ranged', 'character.hunter-aggressive']);
  });

  it('keeps production files self-contained and within explicit budgets', () => {
    const uris = new Set<string>();
    for (const definition of Object.values(assetCatalog.entries)) {
      expect(definition.uri).toMatch(/^\/assets\/art\/.+\.glb$/);
      expect(definition.source).toMatch(/^art-src\/blender\/.+\.blend$/);
      expect(definition.scale).toBeGreaterThan(0);
      expect(definition.validation.maxTriangles).toBeGreaterThan(0);
      expect(definition.validation.maxTextureSize).toBeLessThanOrEqual(2048);
      expect(definition.validation.selfContained).toBe(true);
      expect(definition.validation.requireMeshopt).toBe(true);
      expect(definition.validation.requireKtx2).toBe(true);
      expect(definition.hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(definition.byteLength).toBeGreaterThan(0);
      expect(definition.lods).toHaveLength(1);
      expect(definition.lods[0]).toMatchObject({
        level: 0,
        uri: definition.uri,
        minDistance: 0,
        hash: definition.hash,
        byteLength: definition.byteLength,
      });
      expect(definition.variants.some((variant) => variant.id === 'base')).toBe(true);
      expect(definition.bounds.radius).toBeGreaterThan(0);
      expect(definition.memoryEstimate.cpuBytes).toBeGreaterThan(0);
      expect(definition.memoryEstimate.gpuBytes).toBeGreaterThan(0);
      expect(uris.has(definition.uri)).toBe(false);
      uris.add(definition.uri);
    }
    expect(assetCatalog.entries['character.hunter-ranged'].scale).toBe(0.68);
    expect(assetCatalog.entries['character.hunter-aggressive'].scale).toBe(0.68);
  });

  it('provides a synchronous procedural fallback for every entry', () => {
    for (const [id, definition] of Object.entries(assetCatalog.entries)) {
      const fallback = createFallbackAsset(definition.fallback);
      expect(fallback.source).toBe('fallback');
      expect(fallback.scene.children.length, id).toBeGreaterThan(0);
      for (const socket of definition.sockets) expect(fallback.scene.getObjectByName(socket), `${id}:${socket}`).toBeTruthy();
      for (const clip of Object.values(definition.clips)) {
        expect(fallback.animations.some((animation) => animation.name === clip), `${id}:${clip}`).toBe(true);
      }
      fallback.dispose();
    }
  });

  it('is deeply immutable at runtime', () => {
    expect(Object.isFrozen(assetCatalog)).toBe(true);
    expect(Object.isFrozen(assetCatalog.entries)).toBe(true);
    expect(Object.isFrozen(assetCatalog.entries['viewmodel.runner-rifle'].validation)).toBe(true);
    expect(Object.isFrozen(assetCatalog.entries['viewmodel.runner-rifle'].lods)).toBe(true);
    expect(Object.isFrozen(assetCatalog.entries['viewmodel.runner-rifle'].bounds)).toBe(true);
    expect(Object.isFrozen(surfaceTextureEntries)).toBe(true);
    expect(surfaceTextureMemoryEstimate.cpuBytes).toBe(659_310);
    expect(surfaceTextureMemoryEstimate.gpuBytes).toBe(2_796_256);
  });
});
