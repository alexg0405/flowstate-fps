import type * as THREE from 'three';
import type rawCatalog from './catalog.json';

export type AssetKind = 'viewmodel' | 'character' | 'environment';

export type AssetContentHash = `sha256:${string}`;

export type AssetPreloadGroup = 'startup' | 'combat' | 'level' | 'on-demand';

export interface AssetLodDefinition {
  /** Zero is the highest-detail source and the URI used by the current loader. */
  level: number;
  uri: string;
  minDistance: number;
  hash: AssetContentHash;
  byteLength: number;
}

export interface AssetVariantDefinition {
  id: string;
  label: string;
  /** Editor/runtime tint hint; material implementations remain asset-specific. */
  accent: string;
}

export interface AssetBounds {
  /** Local-space AABB after the catalog's uniform scale is applied. */
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Radius of the AABB-enclosing sphere about the AABB center. */
  radius: number;
}

export interface AssetMemoryEstimate {
  /** Estimated decoded resident accessor, animation, and texture bytes. */
  cpuBytes: number;
  /** Estimated uploaded geometry and GPU-compressed texture bytes. */
  gpuBytes: number;
}

export type FallbackAssetId =
  | 'viewmodel-rifle'
  | 'hunter-ranged'
  | 'hunter-aggressive'
  | 'environment-platform'
  | 'environment-wallrun-panel'
  | 'environment-vault-barrier'
  | 'environment-grapple-anchor'
  | 'environment-route-sign';

export interface AssetValidationBudget {
  maxTriangles: number;
  maxMaterials: number;
  maxTextures: number;
  maxTextureSize: number;
  maxBones: number;
  /**
   * Least number of distinct rig nodes that must directly parent rendered geometry.
   * Guards the limb parenting: every clip animates the shared root, and the root is an
   * ancestor of everything, so per-clip binding checks pass even when a batching step
   * has flattened the limbs into loose siblings of the bones.
   */
  minimumRigAttachments?: number;
  requireMeshopt: boolean;
  requireKtx2: boolean;
  selfContained: boolean;
}

export interface AssetDefinition {
  kind: AssetKind;
  uri: string;
  hash: AssetContentHash;
  byteLength: number;
  lods: readonly AssetLodDefinition[];
  variants: readonly AssetVariantDefinition[];
  bounds: Readonly<AssetBounds>;
  preloadGroup: AssetPreloadGroup;
  memoryEstimate: Readonly<AssetMemoryEstimate>;
  source: string;
  fallback: FallbackAssetId;
  scale: number;
  clips: Readonly<Record<string, string>>;
  sockets: readonly string[];
  validation: Readonly<AssetValidationBudget>;
  tags: readonly string[];
}

export type AssetId = keyof typeof rawCatalog.entries;

export interface AssetCatalog {
  readonly schemaVersion: 1;
  readonly entries: Readonly<Record<AssetId, AssetDefinition>>;
}

export type AssetSource = 'gltf' | 'fallback';

export interface AssetTemplate {
  readonly scene: THREE.Group;
  readonly animations: readonly THREE.AnimationClip[];
  readonly source: AssetSource;
  /** Releases resources owned by the cached template. Called once on eviction. */
  readonly dispose: () => void;
}

export interface AssetHandle {
  readonly id: AssetId;
  readonly definition: AssetDefinition;
  readonly scene: THREE.Group;
  readonly animations: readonly THREE.AnimationClip[];
  readonly source: AssetSource;
  readonly released: boolean;
  /** Releases this instance and decrements the cached template's reference count. */
  release(): void;
}

export interface AssetLoadProgress {
  readonly id: AssetId;
  readonly uri: string;
  readonly loaded: number;
  readonly total?: number;
}

export interface AssetLoadContext {
  readonly id: AssetId;
  readonly definition: AssetDefinition;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: AssetLoadProgress) => void;
}

export interface AssetLoader {
  load(context: AssetLoadContext): Promise<AssetTemplate>;
  dispose?(): void;
}

export interface AssetFallbackContext {
  readonly id: AssetId;
  readonly definition: AssetDefinition;
  readonly error: unknown;
}

export type AssetFallbackFactory = (context: AssetFallbackContext) => AssetTemplate | Promise<AssetTemplate>;

export interface AssetManagerHooks {
  onProgress?: (progress: AssetLoadProgress) => void;
  onError?: (context: AssetFallbackContext) => void;
  onFallback?: (context: AssetFallbackContext) => void;
}

export interface AssetAcquireOptions {
  signal?: AbortSignal;
}

export type AssetCacheState = 'unloaded' | 'loading' | 'ready';

export interface AssetCacheInspection {
  readonly state: AssetCacheState;
  readonly references: number;
  readonly source?: AssetSource;
}
