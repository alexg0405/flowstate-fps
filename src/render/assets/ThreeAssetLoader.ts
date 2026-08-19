import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { AssetLoadContext, AssetLoader, AssetTemplate } from './types';
import { disposeTemplateScene, once } from './resourceLifecycle';

export interface ThreeAssetLoaderOptions {
  renderer: THREE.WebGLRenderer;
  /** Directory containing basis_transcoder.js and basis_transcoder.wasm. */
  ktx2TranscoderPath?: string;
  /** Base URL used to resolve root-relative and relative catalog URIs. */
  baseUrl?: string | URL;
  loadingManager?: THREE.LoadingManager;
  /** Resolves archive/OPFS URLs to blob URLs for both root GLBs and dependencies. */
  urlModifier?: (url: string) => string;
  requestInit?: Omit<RequestInit, 'signal'>;
  fetchImplementation?: typeof fetch;
}

/**
 * Production GLB loader. Root files are fetched explicitly so each cache record
 * has an independent AbortSignal; GLTFLoader handles embedded Meshopt/KTX2 data.
 */
export class ThreeAssetLoader implements AssetLoader {
  private readonly loadingManager: THREE.LoadingManager;
  private readonly gltfLoader: GLTFLoader;
  private readonly ktx2Loader: KTX2Loader;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestInit?: Omit<RequestInit, 'signal'>;
  private disposed = false;

  constructor(options: ThreeAssetLoaderOptions) {
    this.loadingManager = options.loadingManager ?? new THREE.LoadingManager();
    if (options.urlModifier) this.loadingManager.setURLModifier(options.urlModifier);
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.requestInit = options.requestInit;
    this.ktx2Loader = new KTX2Loader(this.loadingManager)
      .setTranscoderPath(options.ktx2TranscoderPath ?? '/vendor/three/basis/')
      .detectSupport(options.renderer);
    this.gltfLoader = new GLTFLoader(this.loadingManager)
      .setKTX2Loader(this.ktx2Loader)
      .setMeshoptDecoder(MeshoptDecoder);
  }

  async load(context: AssetLoadContext): Promise<AssetTemplate> {
    if (this.disposed) throw new Error('ThreeAssetLoader has been disposed.');
    throwIfAborted(context.signal);
    const logicalUrl = new URL(context.definition.uri, this.baseUrl).href;
    const requestUrl = this.loadingManager.resolveURL(logicalUrl);
    this.loadingManager.itemStart(requestUrl);
    try {
      const data = await fetchArrayBuffer(
        this.fetchImplementation,
        requestUrl,
        context.signal,
        this.requestInit,
        (loaded, total) => context.onProgress?.({
          id: context.id,
          uri: context.definition.uri,
          loaded,
          total,
        }),
      );
      throwIfAborted(context.signal);
      await verifyAssetPayload(data, context.definition.byteLength, context.definition.hash);
      throwIfAborted(context.signal);
      const resourcePath = logicalUrl.slice(0, logicalUrl.lastIndexOf('/') + 1);
      const gltf = await this.gltfLoader.parseAsync(data, resourcePath);
      if (context.signal.aborted) {
        disposeTemplateScene(gltf.scene);
        throw abortError(context.signal.reason);
      }
      gltf.scene.name ||= context.id;
      gltf.scene.updateMatrixWorld(true);
      this.loadingManager.itemEnd(requestUrl);
      return {
        scene: gltf.scene,
        animations: gltf.animations,
        source: 'gltf',
        dispose: once(() => disposeTemplateScene(gltf.scene)),
      };
    } catch (error) {
      this.loadingManager.itemError(requestUrl);
      this.loadingManager.itemEnd(requestUrl);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ktx2Loader.dispose();
  }
}

/** Verifies fetched bytes before GLTFLoader parses or allocates GPU resources. */
export async function verifyAssetPayload(data: ArrayBuffer, expectedBytes: number, expectedHash: string): Promise<void> {
  if (data.byteLength !== expectedBytes) {
    throw new Error(`Asset integrity check failed: expected ${expectedBytes} bytes, received ${data.byteLength}.`);
  }
  if (!globalThis.crypto?.subtle) throw new Error('Asset integrity checks require Web Crypto SHA-256 support.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  const actual = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  if (actual !== expectedHash) throw new Error(`Asset integrity check failed: expected ${expectedHash}, received ${actual}.`);
}

async function fetchArrayBuffer(
  fetchImplementation: typeof fetch,
  url: string,
  signal: AbortSignal,
  requestInit: Omit<RequestInit, 'signal'> | undefined,
  onProgress: (loaded: number, total?: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetchImplementation(url, { ...requestInit, signal });
  if (!response.ok) throw new Error(`Asset request failed (${response.status} ${response.statusText}): ${url}`);
  const contentLength = Number(response.headers.get('content-length'));
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
  if (!response.body) {
    const data = await response.arrayBuffer();
    onProgress(data.byteLength, total ?? data.byteLength);
    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    throwIfAborted(signal);
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    loaded += result.value.byteLength;
    onProgress(loaded, total);
  }
  const combined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (loaded === 0) onProgress(0, total);
  return combined.buffer;
}

function resolveBaseUrl(baseUrl?: string | URL): string {
  if (baseUrl) return new URL(baseUrl.toString(), browserBaseUrl()).href;
  return browserBaseUrl();
}

function browserBaseUrl(): string {
  if (typeof document !== 'undefined') return document.baseURI;
  if (typeof location !== 'undefined') return location.href;
  return 'http://localhost/';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

function abortError(reason?: unknown): DOMException {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Asset load aborted.';
  return new DOMException(message, 'AbortError');
}
