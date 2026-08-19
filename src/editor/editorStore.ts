import { create } from 'zustand';
import type {
  CollisionPrimitiveV2,
  EncounterDefinition,
  LevelDocument,
  LevelDocumentV2,
  LightInstance,
  OffMeshLink,
  SpawnDefinition,
  SurfaceTag,
  Vec3,
  VisualInstance,
} from '../contracts';
import { defaultLevel } from '../content/defaultLevel';
import { migrateLevelDocument, migratePrimitive, navigationFlagsFor, traversalFlagsFor } from '../content/migrations';

export type CameraMode = 'perspective' | 'orthographic';

export interface AddVisualOptions {
  assetCatalogVersion?: string;
  defaultScale?: number;
  materialVariantId?: string;
  position?: Vec3;
}

interface EditorState {
  document: LevelDocumentV2;
  selectedId: string | null;
  past: LevelDocumentV2[];
  future: LevelDocumentV2[];
  cameraMode: CameraMode;
  collisionProxiesVisible: boolean;
  setSelected: (id: string | null) => void;
  setCameraMode: (mode: CameraMode) => void;
  setCollisionProxiesVisible: (visible: boolean) => void;
  toggleCollisionProxies: () => void;
  replaceDocument: (document: LevelDocument) => void;
  updatePrimitive: (id: string, patch: Partial<CollisionPrimitiveV2>) => void;
  updateCollision: (id: string, patch: Partial<CollisionPrimitiveV2>) => void;
  updateVisual: (id: string, patch: Partial<VisualInstance>) => void;
  updateLight: (id: string, patch: Partial<LightInstance>) => void;
  updateSpawn: (id: string, patch: Partial<SpawnDefinition>) => void;
  updateEncounter: (id: string, patch: Partial<EncounterDefinition>) => void;
  updateOffMeshLink: (id: string, patch: Partial<OffMeshLink>) => void;
  assignSpawnEncounter: (spawnId: string, encounterId?: string) => void;
  addPrimitive: (kind: CollisionPrimitiveV2['kind']) => void;
  addVisual: (assetId: string, options?: AddVisualOptions) => void;
  addLight: (kind: LightInstance['kind']) => void;
  addSpawn: (kind: SpawnDefinition['kind']) => void;
  addEncounter: () => void;
  addOffMeshLink: () => void;
  duplicateSelected: () => void;
  deleteSelected: () => void;
  setSurface: (id: string, surface: SurfaceTag) => void;
  setEnvironmentPreset: (environmentPresetId: string) => void;
  undo: () => void;
  redo: () => void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

let fallbackId = 0;
function nextId(prefix: string): string {
  const token = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? String(++fallbackId).padStart(8, '0');
  return `${prefix}-${token}`;
}

function normalized(document: LevelDocument): LevelDocumentV2 {
  const next = migrateLevelDocument(document);
  next.primitives = next.collision;
  return next;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  document: normalized(defaultLevel),
  selectedId: null,
  past: [],
  future: [],
  cameraMode: 'perspective',
  collisionProxiesVisible: true,
  setSelected: (selectedId) => set({ selectedId }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setCollisionProxiesVisible: (collisionProxiesVisible) => set({ collisionProxiesVisible }),
  toggleCollisionProxies: () => set({ collisionProxiesVisible: !get().collisionProxiesVisible }),
  replaceDocument: (document) => set({ document: normalized(document), selectedId: null, past: [], future: [] }),
  updatePrimitive: (id, patch) => get().updateCollision(id, patch),
  updateCollision: (id, patch) => commit(set, get, (document) => {
    const primitive = document.collision.find((candidate) => candidate.id === id);
    if (primitive) Object.assign(primitive, clone(patch));
  }),
  updateVisual: (id, patch) => commit(set, get, (document) => {
    const visual = document.visuals.find((candidate) => candidate.id === id);
    if (visual) Object.assign(visual, clone(patch));
  }),
  updateLight: (id, patch) => commit(set, get, (document) => {
    const light = document.lights.find((candidate) => candidate.id === id);
    if (light) Object.assign(light, clone(patch));
  }),
  updateSpawn: (id, patch) => commit(set, get, (document) => {
    const spawn = document.spawns.find((candidate) => candidate.id === id);
    if (spawn) Object.assign(spawn, clone(patch));
  }),
  updateEncounter: (id, patch) => commit(set, get, (document) => {
    const encounter = document.encounters.find((candidate) => candidate.id === id);
    if (encounter) Object.assign(encounter, clone(patch));
  }),
  updateOffMeshLink: (id, patch) => commit(set, get, (document) => {
    const link = document.offMeshLinks.find((candidate) => candidate.id === id);
    if (link) Object.assign(link, clone(patch));
  }),
  assignSpawnEncounter: (spawnId, encounterId) => commit(set, get, (document) => {
    const spawn = document.spawns.find((candidate) => candidate.id === spawnId && candidate.kind !== 'player');
    if (!spawn) return;
    spawn.encounterId = encounterId || undefined;
    for (const encounter of document.encounters) encounter.requiredBotIds = encounter.requiredBotIds.filter((id) => id !== spawnId);
    if (encounterId) {
      const encounter = document.encounters.find((candidate) => candidate.id === encounterId);
      if (encounter) encounter.requiredBotIds = [...encounter.requiredBotIds, spawnId];
    }
  }),
  addPrimitive: (kind) => {
    const id = nextId(kind);
    const primitive = migratePrimitive({
      id,
      kind,
      transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: kind === 'ramp' ? [5, 1, 7] : [4, 2, 4] },
      color: '#f2f0e8',
      collision: true,
      surface: 'default',
    });
    commit(set, get, (document) => document.collision.push(primitive));
    set({ selectedId: id });
  },
  addVisual: (assetId, options = {}) => {
    const id = nextId('visual');
    const scale = options.defaultScale ?? 1;
    const visual: VisualInstance = {
      id,
      assetId,
      transform: {
        position: options.position ?? [0, 1, -5],
        rotation: [0, 0, 0],
        scale: [scale, scale, scale],
      },
      materialVariantId: options.materialVariantId,
      castShadow: true,
      receiveShadow: true,
    };
    commit(set, get, (document) => {
      document.visuals.push(visual);
      if (options.assetCatalogVersion) document.assetCatalogVersion = options.assetCatalogVersion;
    });
    set({ selectedId: id });
  },
  addLight: (kind) => {
    const id = nextId(kind === 'spot' ? 'spot-light' : 'point-light');
    const light: LightInstance = {
      id,
      kind,
      transform: { position: [0, 4, -5], rotation: [-Math.PI / 4, 0, 0], scale: [1, 1, 1] },
      color: kind === 'spot' ? '#f4ec18' : '#08f7ff',
      intensity: kind === 'spot' ? 12 : 8,
      range: 18,
      coneAngle: kind === 'spot' ? Math.PI / 4 : undefined,
      penumbra: kind === 'spot' ? 0.35 : undefined,
      castShadow: false,
    };
    commit(set, get, (document) => document.lights.push(light));
    set({ selectedId: id });
  },
  addSpawn: (kind) => {
    const id = nextId(kind);
    commit(set, get, (document) => document.spawns.push({ id, kind, position: [0, 1.1, 0], rotationY: 0 }));
    set({ selectedId: id });
  },
  addEncounter: () => {
    const id = nextId('encounter');
    commit(set, get, (document) => document.encounters.push({ id, label: 'New arena', checkpoint: [0, 1.1, 0], requiredBotIds: [] }));
    set({ selectedId: id });
  },
  addOffMeshLink: () => {
    const id = nextId('link');
    commit(set, get, (document) => document.offMeshLinks.push({ id, start: [0, 1, 0], end: [0, 1, -4], bidirectional: false, action: 'jump' }));
    set({ selectedId: id });
  },
  duplicateSelected: () => {
    const selectedId = get().selectedId;
    if (!selectedId) return;
    let newId: string | null = null;
    commit(set, get, (document) => {
      const collision = document.collision.find((candidate) => candidate.id === selectedId);
      if (collision) {
        newId = nextId(collision.kind);
        const copy = clone(collision);
        copy.id = newId;
        copy.transform.position = offset(copy.transform.position);
        document.collision.push(copy);
        return;
      }
      const visual = document.visuals.find((candidate) => candidate.id === selectedId);
      if (visual) {
        newId = nextId('visual');
        const copy = clone(visual);
        copy.id = newId;
        copy.transform.position = offset(copy.transform.position);
        document.visuals.push(copy);
        return;
      }
      const light = document.lights.find((candidate) => candidate.id === selectedId);
      if (light) {
        newId = nextId(light.kind === 'spot' ? 'spot-light' : 'point-light');
        const copy = clone(light);
        copy.id = newId;
        copy.transform.position = offset(copy.transform.position);
        document.lights.push(copy);
        return;
      }
      const spawn = document.spawns.find((candidate) => candidate.id === selectedId);
      if (spawn) {
        newId = nextId(spawn.kind);
        const copy = clone(spawn);
        copy.id = newId;
        copy.position = offset(copy.position);
        copy.encounterId = undefined;
        document.spawns.push(copy);
      }
    });
    set({ selectedId: newId });
  },
  deleteSelected: () => {
    const selectedId = get().selectedId;
    if (!selectedId) return;
    commit(set, get, (document) => {
      const removingCollision = document.collision.some((item) => item.id === selectedId);
      const removingEncounter = document.encounters.some((item) => item.id === selectedId);
      document.collision = document.collision.filter((item) => item.id !== selectedId);
      document.visuals = document.visuals.filter((item) => item.id !== selectedId);
      document.lights = document.lights.filter((item) => item.id !== selectedId);
      document.spawns = document.spawns.filter((item) => item.id !== selectedId || item.kind === 'player');
      document.encounters = document.encounters.filter((item) => item.id !== selectedId);
      document.offMeshLinks = document.offMeshLinks.filter((item) => item.id !== selectedId);
      for (const encounter of document.encounters) encounter.requiredBotIds = encounter.requiredBotIds.filter((id) => id !== selectedId);
      if (removingCollision) {
        for (const visual of document.visuals) if (visual.collisionAlignmentId === selectedId) visual.collisionAlignmentId = undefined;
      }
      if (removingEncounter) {
        for (const collision of document.collision) if (collision.gateForEncounterId === selectedId) collision.gateForEncounterId = undefined;
        for (const spawn of document.spawns) if (spawn.encounterId === selectedId) spawn.encounterId = undefined;
        for (const visual of document.visuals) if (visual.gateVisibilityBindingId === selectedId) visual.gateVisibilityBindingId = undefined;
        for (const light of document.lights) if (light.gateVisibilityBindingId === selectedId) light.gateVisibilityBindingId = undefined;
      }
    });
    set({ selectedId: null });
  },
  setSurface: (id, surface) => commit(set, get, (document) => {
    const primitive = document.collision.find((candidate) => candidate.id === id);
    if (!primitive) return;
    primitive.surface = surface;
    primitive.traversal = traversalFlagsFor(surface, primitive.collision);
    primitive.nav = navigationFlagsFor(surface, primitive.collision);
  }),
  setEnvironmentPreset: (environmentPresetId) => commit(set, get, (document) => { document.environmentPresetId = environmentPresetId; }),
  undo: () => {
    const { past, document, future, selectedId } = get();
    const previous = past.at(-1);
    if (!previous) return;
    const restored = normalized(previous);
    set({
      document: restored,
      past: past.slice(0, -1),
      future: [clone(document), ...future],
      selectedId: selectedId && documentHasId(restored, selectedId) ? selectedId : null,
    });
  },
  redo: () => {
    const { past, document, future, selectedId } = get();
    const next = future[0];
    if (!next) return;
    const restored = normalized(next);
    set({
      document: restored,
      past: [...past, clone(document)],
      future: future.slice(1),
      selectedId: selectedId && documentHasId(restored, selectedId) ? selectedId : null,
    });
  },
}));

function commit(
  set: (state: Partial<EditorState>) => void,
  get: () => EditorState,
  mutate: (document: LevelDocumentV2) => void,
): void {
  const before = clone(get().document);
  const document = clone(before);
  mutate(document);
  document.primitives = document.collision;
  set({ document, past: [...get().past.slice(-49), before], future: [] });
}

function offset(position: Vec3): Vec3 {
  return [position[0] + 1, position[1], position[2] + 1];
}

function documentHasId(document: LevelDocumentV2, id: string): boolean {
  return document.collision.some((item) => item.id === id)
    || document.visuals.some((item) => item.id === id)
    || document.lights.some((item) => item.id === id)
    || document.spawns.some((item) => item.id === id)
    || document.encounters.some((item) => item.id === id)
    || document.offMeshLinks.some((item) => item.id === id);
}
