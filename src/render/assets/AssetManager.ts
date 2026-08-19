import type * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { assetCatalog } from './catalog';
import { disposeAssetInstance } from './resourceLifecycle';
import type {
  AssetAcquireOptions,
  AssetCacheInspection,
  AssetCatalog,
  AssetFallbackContext,
  AssetFallbackFactory,
  AssetHandle,
  AssetId,
  AssetLoader,
  AssetManagerHooks,
  AssetTemplate,
} from './types';

interface CacheRecord {
  readonly id: AssetId;
  readonly controller: AbortController;
  readonly promise: Promise<AssetTemplate>;
  references: number;
  state: 'loading' | 'ready' | 'failed';
  template?: AssetTemplate;
}

export interface AssetManagerOptions {
  loader: AssetLoader;
  catalog?: AssetCatalog;
  hooks?: AssetManagerHooks;
  /** Undefined uses procedural fallbacks; null makes asset failures fatal. */
  fallbackFactory?: AssetFallbackFactory | null;
}

export class AssetLoadError extends Error {
  readonly assetId: AssetId;

  constructor(assetId: AssetId, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AssetLoadError';
    this.assetId = assetId;
  }
}

/** Shared-template asset cache with cancellable acquisitions and explicit handles. */
export class AssetManager {
  private readonly loader: AssetLoader;
  private readonly catalog: AssetCatalog;
  private readonly hooks: AssetManagerHooks;
  private readonly fallbackFactory: AssetFallbackFactory | null;
  private readonly records = new Map<AssetId, CacheRecord>();
  private disposed = false;

  constructor(options: AssetManagerOptions) {
    this.loader = options.loader;
    this.catalog = options.catalog ?? assetCatalog;
    this.hooks = options.hooks ?? {};
    // Fallback art only matters when a catalogued asset fails to load, so its
    // geometry builders stay out of the initial download.
    this.fallbackFactory = options.fallbackFactory === undefined
      ? async ({ definition }) => (await import('./fallbacks')).createFallbackAsset(definition.fallback)
      : options.fallbackFactory;
  }

  async acquire(id: AssetId, options: AssetAcquireOptions = {}): Promise<AssetHandle> {
    this.assertActive();
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    const record = this.recordFor(id);
    record.references += 1;
    let reservationActive = true;
    const releaseReservation = () => {
      if (!reservationActive) return;
      reservationActive = false;
      record.references = Math.max(0, record.references - 1);
      if (record.references === 0 && record.state === 'loading') record.controller.abort('No active asset acquisitions.');
    };

    try {
      const template = await waitWithSignal(record.promise, options.signal);
      if (options.signal?.aborted) throw abortError(options.signal.reason);
      const scene = cloneSkeleton(template.scene) as THREE.Group;
      scene.scale.multiplyScalar(this.catalog.entries[id].scale);
      scene.userData.assetId = id;
      scene.userData.assetSource = template.source;
      let released = false;
      reservationActive = false;
      return {
        id,
        definition: this.catalog.entries[id],
        scene,
        animations: template.animations,
        source: template.source,
        get released() { return released; },
        release: () => {
          if (released) return;
          released = true;
          disposeAssetInstance(scene);
          record.references = Math.max(0, record.references - 1);
        },
      };
    } catch (error) {
      releaseReservation();
      throw error;
    }
  }

  async preload(ids: readonly AssetId[], options: AssetAcquireOptions = {}): Promise<void> {
    await Promise.all(ids.map(async (id) => {
      const handle = await this.acquire(id, options);
      handle.release();
    }));
  }

  inspect(id: AssetId): AssetCacheInspection {
    const record = this.records.get(id);
    if (!record || record.state === 'failed') return { state: 'unloaded', references: 0 };
    return {
      state: record.state,
      references: record.references,
      source: record.template?.source,
    };
  }

  /** Evicts one unused template. Returns false while live handles exist. */
  evict(id: AssetId): boolean {
    const record = this.records.get(id);
    if (!record) return true;
    if (record.references > 0) return false;
    this.records.delete(id);
    if (record.state === 'loading') record.controller.abort('Asset evicted.');
    record.template?.dispose();
    return true;
  }

  purgeUnused(): AssetId[] {
    const evicted: AssetId[] = [];
    for (const [id, record] of this.records) {
      if (record.references !== 0 || record.state !== 'ready') continue;
      this.records.delete(id);
      record.template?.dispose();
      evicted.push(id);
    }
    return evicted;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.records.values()) {
      if (record.state === 'loading') record.controller.abort('Asset manager disposed.');
      record.template?.dispose();
    }
    this.records.clear();
    this.loader.dispose?.();
  }

  private recordFor(id: AssetId): CacheRecord {
    const existing = this.records.get(id);
    if (existing && !(existing.state === 'loading' && existing.controller.signal.aborted)) return existing;
    if (existing) this.records.delete(id);
    const definition = this.catalog.entries[id];
    if (!definition) throw new AssetLoadError(id, `Unknown asset ID: ${id}`);
    const controller = new AbortController();
    let record!: CacheRecord;
    const promise = this.loadTemplate(id, controller.signal)
      .then((template) => {
        record.state = 'ready';
        record.template = template;
        return template;
      })
      .catch((error: unknown) => {
        record.state = 'failed';
        if (this.records.get(id) === record) this.records.delete(id);
        throw error;
      });
    record = {
      id,
      controller,
      promise,
      references: 0,
      state: 'loading',
    };
    this.records.set(id, record);
    return record;
  }

  private async loadTemplate(id: AssetId, signal: AbortSignal): Promise<AssetTemplate> {
    const definition = this.catalog.entries[id];
    try {
      const template = await this.loader.load({
        id,
        definition,
        signal,
        onProgress: this.hooks.onProgress,
      });
      if (signal.aborted) {
        template.dispose();
        throw abortError(signal.reason);
      }
      return template;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortError(signal.reason ?? error);
      const context: AssetFallbackContext = { id, definition, error };
      callHook(this.hooks.onError, context);
      if (!this.fallbackFactory) {
        throw new AssetLoadError(id, `Failed to load asset ${id} (${definition.uri}).`, { cause: error });
      }
      try {
        const fallback = await this.fallbackFactory(context);
        if (signal.aborted) {
          fallback.dispose();
          throw abortError(signal.reason);
        }
        callHook(this.hooks.onFallback, context);
        return fallback;
      } catch (fallbackError) {
        if (isAbortError(fallbackError)) throw fallbackError;
        throw new AssetLoadError(id, `Failed to load asset ${id} and its fallback.`, { cause: fallbackError });
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('AssetManager has been disposed.');
  }
}

function callHook<T>(hook: ((context: T) => void) | undefined, context: T): void {
  if (!hook) return;
  try {
    hook(context);
  } catch {
    // Diagnostics must never change asset loading semantics.
  }
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError(signal.reason));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function abortError(reason?: unknown): DOMException {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Asset acquisition aborted.';
  return new DOMException(message, 'AbortError');
}
