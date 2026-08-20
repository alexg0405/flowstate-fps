import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import * as THREE from 'three';
import type { LegacyLevelDocumentV1, LevelPrimitive } from '../src/contracts';
import { defaultLevel } from '../src/content/defaultLevel';
import { useEditorStore } from '../src/editor/editorStore';
import { createEditorAssetProxy, editorSemanticVariants, getEditorAssetItem } from '../src/editor/assetCatalogAdapter';
import { currentNavigationData, navigationSourceKey, type NavigationBake } from '../src/editor/navigationState';
import { createProjectArchive, importProject, saveProjectDirectory } from '../src/editor/projectIO';

describe('editor encounter commands', () => {
  beforeEach(() => {
    useEditorStore.getState().replaceDocument(defaultLevel);
    useEditorStore.getState().setCollisionProxiesVisible(true);
  });

  it('moves a bot between encounters atomically and supports undo', () => {
    // The first hostile the shipped route authors. Read from the document rather than
    // named, so re-authoring the arenas -- which the crowd pass did -- does not break a
    // case about the editor's undo stack.
    const botId = useEditorStore.getState().document.spawns.find((item) => item.encounterId === 'arena-1')!.id;
    useEditorStore.getState().assignSpawnEncounter(botId, 'arena-2');
    let document = useEditorStore.getState().document;
    expect(document.encounters.find((item) => item.id === 'arena-1')?.requiredBotIds).not.toContain(botId);
    expect(document.encounters.find((item) => item.id === 'arena-2')?.requiredBotIds).toContain(botId);
    expect(document.spawns.find((item) => item.id === botId)?.encounterId).toBe('arena-2');

    useEditorStore.getState().undo();
    document = useEditorStore.getState().document;
    expect(document.encounters.find((item) => item.id === 'arena-1')?.requiredBotIds).toContain(botId);
    expect(document.spawns.find((item) => item.id === botId)?.encounterId).toBe('arena-1');
  });

  it('creates encounter and off-mesh link records with stable IDs', () => {
    const beforeEncounters = useEditorStore.getState().document.encounters.length;
    const beforeLinks = useEditorStore.getState().document.offMeshLinks.length;
    useEditorStore.getState().addEncounter();
    useEditorStore.getState().addOffMeshLink();
    const document = useEditorStore.getState().document;
    expect(document.encounters).toHaveLength(beforeEncounters + 1);
    expect(document.offMeshLinks).toHaveLength(beforeLinks + 1);
    expect(new Set([...document.encounters, ...document.offMeshLinks].map((item) => item.id)).size).toBe(document.encounters.length + document.offMeshLinks.length);
  });

  it('normalizes legacy documents to V2 and preserves the collision compatibility alias', () => {
    const legacy = legacyDocument();

    useEditorStore.getState().replaceDocument(legacy);
    const document = useEditorStore.getState().document;
    expect(document.schemaVersion).toBe(2);
    expect(document.collision).toHaveLength(legacy.primitives.length);
    expect(document.primitives).toBe(document.collision);
    expect(document.collision[0].traversal).toBeDefined();
  });

  it('authors visual variants, bindings, and shadow flags through undo and redo', () => {
    const store = useEditorStore.getState();
    store.addVisual('environment.wallrun-panel', { defaultScale: 1.5 });
    const visualId = useEditorStore.getState().selectedId!;
    const collisionId = useEditorStore.getState().document.collision[0].id;

    useEditorStore.getState().updateVisual(visualId, {
      materialVariantId: 'hazard-yellow',
      collisionAlignmentId: collisionId,
      gateVisibilityBindingId: 'arena-1',
      castShadow: false,
    });
    let visual = useEditorStore.getState().document.visuals.find((item) => item.id === visualId)!;
    expect(visual.transform.scale).toEqual([1.5, 1.5, 1.5]);
    expect(visual).toMatchObject({ materialVariantId: 'hazard-yellow', collisionAlignmentId: collisionId, gateVisibilityBindingId: 'arena-1', castShadow: false });

    useEditorStore.getState().undo();
    visual = useEditorStore.getState().document.visuals.find((item) => item.id === visualId)!;
    expect(visual.materialVariantId).toBeUndefined();
    expect(visual.castShadow).toBe(true);
    expect(useEditorStore.getState().selectedId).toBe(visualId);

    useEditorStore.getState().redo();
    visual = useEditorStore.getState().document.visuals.find((item) => item.id === visualId)!;
    expect(visual.materialVariantId).toBe('hazard-yellow');
    expect(visual.collisionAlignmentId).toBe(collisionId);
    expect(useEditorStore.getState().selectedId).toBe(visualId);
  });

  it('duplicates visual assets and clears bindings when collision is deleted', () => {
    useEditorStore.getState().addVisual('environment.vault-barrier');
    const originalId = useEditorStore.getState().selectedId!;
    const collisionId = useEditorStore.getState().document.collision[0].id;
    useEditorStore.getState().updateVisual(originalId, { collisionAlignmentId: collisionId });
    useEditorStore.getState().duplicateSelected();
    const copyId = useEditorStore.getState().selectedId!;
    expect(copyId).not.toBe(originalId);
    expect(useEditorStore.getState().document.visuals.find((item) => item.id === copyId)?.transform.position).toEqual([1, 1, -4]);

    useEditorStore.getState().setSelected(collisionId);
    useEditorStore.getState().deleteSelected();
    expect(useEditorStore.getState().document.visuals.every((item) => item.collisionAlignmentId !== collisionId)).toBe(true);
  });

  it('authors light instances and keeps the collision proxy toggle out of history', () => {
    const historyBefore = useEditorStore.getState().past.length;
    useEditorStore.getState().toggleCollisionProxies();
    expect(useEditorStore.getState().collisionProxiesVisible).toBe(false);
    expect(useEditorStore.getState().past).toHaveLength(historyBefore);

    useEditorStore.getState().addLight('spot');
    const lightId = useEditorStore.getState().selectedId!;
    const light = useEditorStore.getState().document.lights.find((item) => item.id === lightId)!;
    expect(light).toMatchObject({ kind: 'spot', castShadow: false });
    expect(light.gateVisibilityBindingId).toBeUndefined();
    expect(light.coneAngle).toBeGreaterThan(0);
  });

  it('clears every gameplay and presentation binding when an encounter is deleted', () => {
    const collisionId = useEditorStore.getState().document.collision[0].id;
    useEditorStore.getState().updateCollision(collisionId, { gateForEncounterId: 'arena-1' });
    useEditorStore.getState().addVisual('environment.route-sign');
    const visualId = useEditorStore.getState().selectedId!;
    useEditorStore.getState().updateVisual(visualId, { gateVisibilityBindingId: 'arena-1' });
    useEditorStore.getState().addLight('point');
    const lightId = useEditorStore.getState().selectedId!;
    useEditorStore.getState().updateLight(lightId, { gateVisibilityBindingId: 'arena-1' });

    useEditorStore.getState().setSelected('arena-1');
    useEditorStore.getState().deleteSelected();
    const document = useEditorStore.getState().document;
    expect(document.collision.find((item) => item.id === collisionId)?.gateForEncounterId).toBeUndefined();
    expect(document.visuals.find((item) => item.id === visualId)?.gateVisibilityBindingId).toBeUndefined();
    expect(document.lights.find((item) => item.id === lightId)?.gateVisibilityBindingId).toBeUndefined();
    expect(document.spawns.every((item) => item.encounterId !== 'arena-1')).toBe(true);
  });

  it('opens canonical V2 JSON projects', async () => {
    useEditorStore.getState().addVisual('environment.route-sign', { materialVariantId: 'signal-magenta' });
    const source = useEditorStore.getState().document;
    const { primitives: _primitives, ...serialized } = source;
    const file = new File([JSON.stringify(serialized)], 'white-line.json', { type: 'application/json' });
    const project = await importProject(file);
    expect(project.level.schemaVersion).toBe(2);
    expect(project.level.visuals).toHaveLength(source.visuals.length);
    expect(project.level.primitives).toBe(project.level.collision);
  });

  it('opens legacy V1 JSON projects through the V2 migration path', async () => {
    const legacy = legacyDocument();
    const file = new File([JSON.stringify(legacy)], 'white-line-v1.json', { type: 'application/json' });
    const project = await importProject(file);
    expect(project.level.schemaVersion).toBe(2);
    expect(project.level.collision).toHaveLength(legacy.primitives.length);
    expect(project.level.visuals).toEqual([]);
    expect(project.level.lights).toEqual([]);
    expect(project.level.primitives).toBe(project.level.collision);
  });

  it('round-trips a canonical V2 project archive with its navmesh payload', async () => {
    useEditorStore.getState().addVisual('environment.route-sign', {
      materialVariantId: 'signal-magenta',
      assetCatalogVersion: 'core-v1',
    });
    const visualId = useEditorStore.getState().selectedId!;
    useEditorStore.getState().updateVisual(visualId, {
      collisionAlignmentId: defaultLevel.collision[0].id,
      gateVisibilityBindingId: 'arena-1',
      castShadow: false,
      receiveShadow: false,
    });
    const source = useEditorStore.getState().document;
    const navMeshData = new Uint8Array([0x46, 0x50, 0x53, 0x32]);
    const archive = createProjectArchive(source, navMeshData);
    const serialized = JSON.parse(strFromU8(unzipSync(archive)['level.json'])) as Record<string, unknown>;
    const file = new File([archive as BlobPart], 'white-line.fpsproj', { type: 'application/octet-stream' });
    const project = await importProject(file);
    const visual = project.level.visuals.find((item) => item.id === visualId);

    expect(serialized.schemaVersion).toBe(2);
    expect(serialized.collision).toBeDefined();
    expect(serialized.primitives).toBeUndefined();
    expect(serialized.assetCatalogVersion).toBe('core-v1');
    expect(visual).toMatchObject({
      assetId: 'environment.route-sign',
      materialVariantId: 'signal-magenta',
      collisionAlignmentId: defaultLevel.collision[0].id,
      gateVisibilityBindingId: 'arena-1',
      castShadow: false,
      receiveShadow: false,
    });
    expect(project.navMeshData).toEqual(navMeshData);
    expect(project.level.primitives).toBe(project.level.collision);
  });

  it('invalidates baked navigation only when collision or off-mesh source data changes', () => {
    const sourceKey = navigationSourceKey(defaultLevel);
    const bake: NavigationBake = { data: new Uint8Array([1, 2, 3]), sourceKey };
    const presentationOnly = structuredClone(defaultLevel);
    presentationOnly.visuals[0].castShadow = !presentationOnly.visuals[0].castShadow;
    presentationOnly.lights[0].intensity += 1;
    expect(navigationSourceKey(presentationOnly)).toBe(sourceKey);
    expect(currentNavigationData(bake, navigationSourceKey(presentationOnly))).toBe(bake.data);

    const collisionEdit = structuredClone(defaultLevel);
    const [collisionX, collisionY, collisionZ] = collisionEdit.collision[0].transform.position;
    collisionEdit.collision[0].transform.position = [collisionX + 1, collisionY, collisionZ];
    expect(currentNavigationData(bake, navigationSourceKey(collisionEdit))).toBeUndefined();

    const navigationEdit = structuredClone(defaultLevel);
    navigationEdit.collision[0].nav.walkable = !navigationEdit.collision[0].nav.walkable;
    expect(currentNavigationData(bake, navigationSourceKey(navigationEdit))).toBeUndefined();

    const linkEdit = structuredClone(defaultLevel);
    const [linkX, linkY, linkZ] = linkEdit.offMeshLinks[0].end;
    linkEdit.offMeshLinks[0].end = [linkX, linkY, linkZ + 1];
    expect(currentNavigationData(bake, navigationSourceKey(linkEdit))).toBeUndefined();
  });

  it('removes a stale navmesh file when saving a directory without a current bake', async () => {
    const removeEntry = vi.fn(async () => undefined);
    const getFileHandle = vi.fn(async () => ({
      createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
    }));
    const directory = { getFileHandle, removeEntry } as unknown as FileSystemDirectoryHandle;
    const originalPicker = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker');
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(async () => directory),
    });

    try {
      await expect(saveProjectDirectory(defaultLevel)).resolves.toBe(true);
      expect(getFileHandle).toHaveBeenCalledWith('level.json', { create: true });
      expect(removeEntry).toHaveBeenCalledWith('navmesh.bin');
    } finally {
      if (originalPicker) Object.defineProperty(window, 'showDirectoryPicker', originalPicker);
      else Reflect.deleteProperty(window, 'showDirectoryPicker');
    }
  });

  it('exposes traversal material variants using the runtime semantic accents', () => {
    expect(editorSemanticVariants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'wall-run', accent: '#4defff' }),
      expect.objectContaining({ id: 'vault', accent: '#ff3569' }),
      expect.objectContaining({ id: 'mantle', accent: '#ff3569' }),
      expect.objectContaining({ id: 'no-traverse', accent: '#ffb547' }),
    ]));
    const variants = getEditorAssetItem('environment.vault-barrier')?.variants;
    expect(variants?.map((variant) => variant.id)).toEqual(expect.arrayContaining([
      'base', 'hazard-yellow', 'signal-magenta', 'weathered', 'default', 'wall-run', 'vault', 'mantle', 'no-traverse',
    ]));

    const proxy = createEditorAssetProxy('environment.vault-barrier', 'vault');
    const barrier = proxy.getObjectByName('vault_barrier') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(`#${barrier.material.color.getHexString()}`).toBe('#ff3569');
    expect(`#${barrier.material.emissive.getHexString()}`).toBe('#ff3569');
    (proxy.userData.editorDispose as (() => void))();
  });
});

function legacyDocument(): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: defaultLevel.id,
    name: defaultLevel.name,
    units: 'meters',
    primitives: defaultLevel.collision.map(({ traversal: _traversal, nav: _nav, ...primitive }) => primitive satisfies LevelPrimitive),
    spawns: structuredClone(defaultLevel.spawns),
    encounters: structuredClone(defaultLevel.encounters),
    offMeshLinks: structuredClone(defaultLevel.offMeshLinks),
    exit: defaultLevel.exit,
  };
}
