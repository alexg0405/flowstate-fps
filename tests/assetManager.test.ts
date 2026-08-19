import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  AssetLoadError,
  AssetManager,
  type AssetId,
  type AssetLoadContext,
  type AssetLoader,
  type AssetTemplate,
} from '../src/render/assets';

const ASSET_ID: AssetId = 'character.hunter-ranged';

describe('AssetManager', () => {
  it('coalesces loads, clones instances, reference-counts handles, and evicts once', async () => {
    const template = makeTemplate();
    const loader = new ImmediateLoader(template);
    const manager = new AssetManager({ loader, fallbackFactory: null });

    const [first, second] = await Promise.all([manager.acquire(ASSET_ID), manager.acquire(ASSET_ID)]);
    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(first.scene).not.toBe(second.scene);
    expect(first.scene).not.toBe(template.scene);
    expect(manager.inspect(ASSET_ID)).toMatchObject({ state: 'ready', references: 2, source: 'gltf' });

    first.release();
    first.release();
    expect(first.released).toBe(true);
    expect(manager.evict(ASSET_ID)).toBe(false);
    second.release();
    expect(manager.inspect(ASSET_ID).references).toBe(0);
    expect(manager.purgeUnused()).toEqual([ASSET_ID]);
    expect(template.dispose).toHaveBeenCalledTimes(1);
  });

  it('preloads into a zero-reference cache and reuses it', async () => {
    const template = makeTemplate();
    const loader = new ImmediateLoader(template);
    const manager = new AssetManager({ loader, fallbackFactory: null });
    await manager.preload([ASSET_ID]);
    expect(manager.inspect(ASSET_ID)).toMatchObject({ state: 'ready', references: 0 });
    const handle = await manager.acquire(ASSET_ID);
    expect(loader.load).toHaveBeenCalledTimes(1);
    handle.release();
    manager.dispose();
    expect(template.dispose).toHaveBeenCalledTimes(1);
    expect(loader.dispose).toHaveBeenCalledTimes(1);
  });

  it('reports load errors and supplies a fallback template', async () => {
    const failure = new Error('network unavailable');
    const loader: AssetLoader = { load: vi.fn(async () => { throw failure; }) };
    const fallback = makeTemplate('fallback');
    const onError = vi.fn();
    const onFallback = vi.fn();
    const fallbackFactory = vi.fn(async () => fallback);
    const manager = new AssetManager({ loader, fallbackFactory, hooks: { onError, onFallback } });

    const handle = await manager.acquire(ASSET_ID);
    expect(handle.source).toBe('fallback');
    expect(handle.scene.userData.assetSource).toBe('fallback');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ id: ASSET_ID, error: failure }));
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(fallbackFactory).toHaveBeenCalledTimes(1);
    handle.release();
    manager.dispose();
  });

  it('can make missing production art fatal', async () => {
    const loader: AssetLoader = { load: vi.fn(async () => { throw new Error('404'); }) };
    const manager = new AssetManager({ loader, fallbackFactory: null });
    await expect(manager.acquire(ASSET_ID)).rejects.toBeInstanceOf(AssetLoadError);
    expect(manager.inspect(ASSET_ID).state).toBe('unloaded');
  });

  it('aborts the underlying load when its only acquisition is cancelled', async () => {
    let backendSignal: AbortSignal | undefined;
    const loader: AssetLoader = {
      load: vi.fn((context) => {
        backendSignal = context.signal;
        return rejectWhenAborted(context.signal);
      }),
    };
    const manager = new AssetManager({ loader, fallbackFactory: null });
    const controller = new AbortController();
    const pending = manager.acquire(ASSET_ID, { signal: controller.signal });
    controller.abort('test cancellation');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(backendSignal?.aborted).toBe(true);
    expect(manager.inspect(ASSET_ID).state).toBe('unloaded');
  });

  it('does not abort a shared load while another acquisition remains', async () => {
    const deferred = makeDeferred<AssetTemplate>();
    let backendSignal: AbortSignal | undefined;
    const loader: AssetLoader = {
      load: vi.fn((context) => {
        backendSignal = context.signal;
        return deferred.promise;
      }),
    };
    const manager = new AssetManager({ loader, fallbackFactory: null });
    const controller = new AbortController();
    const cancelled = manager.acquire(ASSET_ID, { signal: controller.signal });
    const survivor = manager.acquire(ASSET_ID);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(backendSignal?.aborted).toBe(false);
    deferred.resolve(makeTemplate());
    const handle = await survivor;
    expect(manager.inspect(ASSET_ID).references).toBe(1);
    handle.release();
    manager.dispose();
  });

  it('starts a fresh load when reacquired before an aborted backend settles', async () => {
    const first = makeDeferred<AssetTemplate>();
    const replacement = makeTemplate();
    const loader: AssetLoader = {
      load: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(async () => replacement),
    };
    const manager = new AssetManager({ loader, fallbackFactory: null });
    const controller = new AbortController();
    const cancelled = manager.acquire(ASSET_ID, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    const next = manager.acquire(ASSET_ID);
    expect(loader.load).toHaveBeenCalledTimes(2);
    first.resolve(makeTemplate());
    const handle = await next;
    expect(handle.source).toBe('gltf');
    handle.release();
    manager.dispose();
  });

  it('disposes a late template returned by a loader that ignores cancellation', async () => {
    const deferred = makeDeferred<AssetTemplate>();
    const lateTemplate = makeTemplate();
    const loader: AssetLoader = { load: vi.fn(() => deferred.promise) };
    const manager = new AssetManager({ loader, fallbackFactory: null });
    const controller = new AbortController();
    const pending = manager.acquire(ASSET_ID, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    deferred.resolve(lateTemplate);
    await vi.waitFor(() => expect(lateTemplate.dispose).toHaveBeenCalledTimes(1));
    expect(manager.inspect(ASSET_ID).state).toBe('unloaded');
  });
});

class ImmediateLoader implements AssetLoader {
  readonly load: ReturnType<typeof vi.fn<(context: AssetLoadContext) => Promise<AssetTemplate>>>;
  readonly dispose = vi.fn();

  constructor(template: AssetTemplate) {
    this.load = vi.fn(async () => template);
  }
}

function makeTemplate(source: AssetTemplate['source'] = 'gltf') {
  const scene = new THREE.Group();
  scene.name = 'template';
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  return { scene, animations: [], source, dispose: vi.fn() };
}

function rejectWhenAborted(signal: AbortSignal): Promise<AssetTemplate> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
