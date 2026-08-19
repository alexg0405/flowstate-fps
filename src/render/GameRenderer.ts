import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { GameEvent, RuntimeLevelV1, SaveDataV1, SimulationSnapshot, Vec3 } from '../contracts';
import { DEFAULT_ASSET_CATALOG_VERSION, DEFAULT_ENVIRONMENT_PRESET_ID } from '../content/migrations';
import { AssetManager, getAssetDefinition, isAssetId, listPreloadGroup, ThreeAssetLoader, type AssetHandle, type AssetId } from './assets';
import { surfaceTextureMemoryEstimate } from './assets/surfaceTextures';
import { CharacterPresenter } from './presentation/CharacterPresenter';
import { FxPresenter } from './presentation/FxPresenter';
import { GhostPresenter } from './presentation/GhostPresenter';
import { GrapplePresenter } from './presentation/GrapplePresenter';
import { MaterialLibrary } from './presentation/MaterialLibrary';
import { PostPipeline } from './presentation/PostPipeline';
import { ResolutionController } from './ResolutionController';
import { ViewmodelPresenter } from './presentation/ViewmodelPresenter';
import { WorldPresenter } from './presentation/WorldPresenter';

/** Speed at which the motion cues start, and where they reach full strength. */
const SPEED_CUE_START = 11;
const SPEED_CUE_FULL = 30;
/** Degrees of extra field of view at full speed. */
const SPEED_FOV_KICK = 11;

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  frameMs: number;
  renderScale: number;
  assetCpuBytes: number;
  assetGpuBytes: number;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(92, 1, 0.025, 520);
  private readonly viewScene = new THREE.Scene();
  private readonly viewCamera = new THREE.PerspectiveCamera(76, 1, 0.008, 8);
  private readonly materials: MaterialLibrary;
  private readonly world: WorldPresenter;
  private readonly characters: CharacterPresenter;
  private readonly viewmodel: ViewmodelPresenter;
  private readonly fx: FxPresenter;
  private readonly grapple: GrapplePresenter;
  private readonly ghost: GhostPresenter;
  private readonly post: PostPipeline;
  private readonly assetManager: AssetManager;
  private readonly assetRoot = new THREE.Group();
  private readonly sun = new THREE.DirectionalLight('#ffd9cb', 2.05);
  private readonly sunTarget = new THREE.Object3D();
  private environmentTexture: THREE.Texture | null = null;
  private resizeObserver: ResizeObserver;
  private settings: SaveDataV1['settings'];
  private lastFrameAt = performance.now();
  private dynamicScale = 1;
  private readonly resolution = new ResolutionController();
  private cameraImpulse = 0;
  private cameraImpulsePhase = 0;
  private lastLocomotion: SimulationSnapshot['player']['locomotion'] | null = null;
  private readonly deterministicPresentation = new URLSearchParams(location.search).get('visualRegression') === '1';
  private disposed = false;
  private assetAbort: AbortController | null = null;
  private assetHandles: AssetHandle[] = [];
  private readonly assetGateBindings = new Map<THREE.Object3D, string>();
  private readonly assetInstanceMaterials: THREE.Material[] = [];
  private viewmodelHandle: AssetHandle | null = null;
  private assetCpuBytes = surfaceTextureMemoryEstimate.cpuBytes;
  private assetGpuBytes = surfaceTextureMemoryEstimate.gpuBytes;
  private readonly grappleEmitterOffset = new THREE.Vector3();
  private readonly projection = new THREE.Vector3();
  private authoredViewmodel: THREE.Object3D | null = null;
  private authoredViewmodelClips: readonly THREE.AnimationClip[] = [];

  constructor(readonly canvas: HTMLCanvasElement, settings: SaveDataV1['settings']) {
    this.settings = { ...settings };
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.62;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.scene.background = new THREE.Color('#080b18');
    this.scene.fog = new THREE.FogExp2('#111326', 0.0062);

    this.materials = new MaterialLibrary(this.renderer);
    this.world = new WorldPresenter(this.materials);
    this.characters = new CharacterPresenter(this.materials);
    this.characters.updateSettings(settings);
    this.viewmodel = new ViewmodelPresenter(this.materials, settings);
    this.fx = new FxPresenter(this.materials, settings);
    this.grapple = new GrapplePresenter(this.materials, settings);
    this.ghost = new GhostPresenter(settings);
    this.assetRoot.name = 'Catalog Assets';
    this.scene.add(this.world.environmentRoot, this.world.root, this.assetRoot, this.characters.root, this.fx.root, this.grapple.root, this.grapple.aimRoot, this.ghost.root);
    this.viewScene.add(this.viewmodel.root);
    this.setupLighting();
    this.setupEnvironmentMap();
    this.assetManager = new AssetManager({
      loader: new ThreeAssetLoader({ renderer: this.renderer, ktx2TranscoderPath: '/vendor/three/basis/' }),
    });
    this.post = new PostPipeline(this.renderer, this.scene, this.camera, this.viewScene, this.viewCamera, settings);

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  updateSettings(settings: SaveDataV1['settings']): void {
    this.settings = { ...settings };
    this.viewmodel.updateSettings(settings);
    this.characters.updateSettings(settings);
    this.fx.updateSettings(settings);
    this.grapple.updateSettings(settings);
    this.ghost.updateSettings(settings);
    this.post.updateSettings(settings);
    if (!this.dynamicResolutionEnabled()) {
      this.dynamicScale = 1;
      this.resolution.reset();
    }
    this.resize();
  }

  async loadLevel(level: RuntimeLevelV1): Promise<void> {
    if (level.assetCatalogVersion !== DEFAULT_ASSET_CATALOG_VERSION) {
      throw new Error(`Asset catalog ${level.assetCatalogVersion} is incompatible; this build requires ${DEFAULT_ASSET_CATALOG_VERSION}.`);
    }
    if (level.environmentPresetId !== DEFAULT_ENVIRONMENT_PRESET_ID) {
      throw new Error(`Environment preset ${level.environmentPresetId} is unavailable; this build provides ${DEFAULT_ENVIRONMENT_PRESET_ID}.`);
    }
    this.releaseLevelAssets();
    this.world.loadLevel(level);
    await this.materials.ready();
    if (this.disposed) return;
    const controller = new AbortController();
    this.assetAbort = controller;
    const assetLoads: Promise<void>[] = [
      this.preloadCharacterAssets(controller.signal),
      this.loadViewmodelAsset(controller.signal),
    ];
    const gateIdByEncounter = new Map(
      level.primitives
        .filter((primitive) => primitive.gateForEncounterId)
        .map((primitive) => [primitive.gateForEncounterId!, primitive.id] as const),
    );
    for (const visual of level.visuals) {
      if (!isAssetId(visual.assetId)) continue;
      const gateId = visual.gateVisibilityBindingId
        ? gateIdByEncounter.get(visual.gateVisibilityBindingId) ?? visual.gateVisibilityBindingId
        : undefined;
      assetLoads.push(this.loadVisualAsset(visual.assetId, visual, controller.signal, gateId));
    }
    await Promise.allSettled(assetLoads);
    if (this.disposed || controller.signal.aborted) return;
    this.refreshAssetMemoryEstimate();
    await Promise.all([
      this.renderer.compileAsync(this.scene, this.camera),
      this.renderer.compileAsync(this.viewScene, this.viewCamera),
    ]);
  }

  render(
    snapshot: SimulationSnapshot,
    events: readonly GameEvent[],
    interpolationAlpha = 1,
    ghostPosition: Vec3 | null = null,
  ): RenderStats {
    const renderStarted = performance.now();
    const frameSeconds = this.deterministicPresentation
      ? 0
      : Math.min(0.1, Math.max(1 / 240, (renderStarted - this.lastFrameAt) / 1000));
    this.lastFrameAt = renderStarted;
    const time = this.deterministicPresentation ? 12 : renderStarted / 1000;

    const playerId = snapshot.entities[0]?.id;
    this.consumeEvents(events, playerId);
    this.applyWeaponVisual(snapshot);
    this.consumeLocomotionImpulse(snapshot);
    this.updateCamera(snapshot, frameSeconds);
    this.updateSun(snapshot);
    this.world.update(time, snapshot.openGateIds, snapshot.camera.position);
    this.updateAssetGateBindings(snapshot.openGateIds);
    this.characters.consume(events, time);
    this.characters.update(snapshot, time, frameSeconds, interpolationAlpha);
    this.viewmodel.consume(events);
    this.viewmodel.update(snapshot, time, frameSeconds);
    this.fx.consume(events, time, playerId);
    this.fx.update(time, frameSeconds);
    this.viewmodel.grappleEmitterOffset(this.grappleEmitterOffset);
    this.grapple.update(snapshot, time, this.grappleEmitterOffset);
    this.grapple.updateAim(snapshot, time);
    this.ghost.update(ghostPosition, snapshot.camera.position, time, frameSeconds);

    this.post.setSpeed(this.speedDrive(snapshot));
    this.post.render(frameSeconds);
    const renderMs = performance.now() - renderStarted;
    // Fed the true frame delta, not the renderer's own slice of it: simulation, React
    // and compositing all land inside the budget the scale is protecting.
    if (!this.deterministicPresentation) this.updateDynamicResolution(frameSeconds * 1000);
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      frameMs: renderMs,
      renderScale: this.effectiveRenderScale(),
      assetCpuBytes: this.assetCpuBytes,
      assetGpuBytes: this.assetGpuBytes,
    };
  }

  setCollisionDebug(visible: boolean): void {
    this.world.setCollisionDebug(visible);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.releaseLevelAssets();
    this.assetManager.dispose();
    this.post.dispose();
    this.ghost.dispose();
    this.grapple.dispose();
    this.fx.dispose();
    this.viewmodel.dispose();
    this.characters.dispose();
    this.world.dispose();
    this.environmentTexture?.dispose();
    this.materials.dispose();
    this.renderer.dispose();
  }

  /**
   * The authored runner-rifle GLB cannot represent an arbitrary build, so the
   * viewmodel is rendered procedurally from parts instead and the asset is no
   * longer fetched. `applyWeaponVisual` keeps it in step with the loadout.
   */
  private applyWeaponVisual(snapshot: SimulationSnapshot): void {
    const active = snapshot.player.weapons.slots[snapshot.player.weapons.activeSlot];
    if (!active) return;
    // The authored runner-rifle stands in for the carbine because it looks far
    // better than the procedural body; the other chassis are built from parts, so
    // fitted parts are visible on those. Carbine part swaps change stats only.
    const authored = active.chassisId === 'carbine' ? this.authoredViewmodel : null;
    this.viewmodel.setExternalModel(authored, authored ? this.authoredViewmodelClips : []);
    if (!authored) this.viewmodel.applyBuild(active.chassisId, active.parts);
  }

  private async loadViewmodelAsset(signal: AbortSignal): Promise<void> {
    const id = listPreloadGroup('startup').find((candidate) => getAssetDefinition(candidate).kind === 'viewmodel')
      ?? 'viewmodel.runner-rifle';
    const handle = await this.assetManager.acquire(id, { signal });
    if (signal.aborted || this.disposed) {
      handle.release();
      return;
    }
    if (handle.source === 'gltf') {
      this.attachCatalogDiagnostics(handle);
      this.assetInstanceMaterials.push(...this.materials.decorateImported(handle.scene));
      this.viewmodelHandle = handle;
      this.assetHandles.push(handle);
      this.authoredViewmodel = handle.scene;
      this.authoredViewmodelClips = handle.animations;
      this.viewmodel.setExternalModel(handle.scene, handle.animations);
    } else {
      handle.release();
    }
  }

  private async preloadCharacterAssets(signal: AbortSignal): Promise<void> {
    const characterIds = listPreloadGroup('combat').filter((id) => getAssetDefinition(id).kind === 'character');
    const loaded = await Promise.all(characterIds.map((id) => this.assetManager.acquire(id, { signal })));
    for (const handle of loaded) {
      if (signal.aborted || this.disposed) {
        handle.release();
        continue;
      }
      if (handle.source !== 'gltf') {
        handle.release();
        continue;
      }
      this.attachCatalogDiagnostics(handle);
      this.assetInstanceMaterials.push(...this.materials.decorateImported(handle.scene));
      const profile = handle.id === 'character.hunter-aggressive' ? 'aggressive' : 'ranged';
      this.characters.setExternalTemplate(profile, handle.scene, handle.animations);
      this.assetHandles.push(handle);
    }
  }

  private async loadVisualAsset(
    id: AssetId,
    visual: RuntimeLevelV1['visuals'][number],
    signal: AbortSignal,
    gateId?: string,
  ): Promise<void> {
    const handle = await this.assetManager.acquire(id, { signal });
    if (signal.aborted || this.disposed) {
      handle.release();
      return;
    }
    handle.scene.position.fromArray(visual.transform.position);
    this.attachCatalogDiagnostics(handle);
    handle.scene.rotation.set(...visual.transform.rotation);
    handle.scene.scale.multiply(new THREE.Vector3().fromArray(visual.transform.scale));
    handle.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = visual.castShadow;
      object.receiveShadow = visual.receiveShadow;
    });
    handle.scene.userData.visualInstanceId = visual.id;
    if (handle.source === 'gltf') this.assetInstanceMaterials.push(...this.materials.decorateImported(handle.scene));
    this.applyMaterialVariant(handle.scene, handle.definition.variants, visual.materialVariantId);
    if (gateId) this.assetGateBindings.set(handle.scene, gateId);
    this.assetRoot.add(handle.scene);
    this.assetHandles.push(handle);
  }

  private releaseLevelAssets(): void {
    this.assetAbort?.abort('Level presentation replaced.');
    this.assetAbort = null;
    this.viewmodel.setExternalModel(null);
    this.characters.clearExternalTemplates();
    this.viewmodelHandle = null;
    this.assetGateBindings.clear();
    this.assetInstanceMaterials.forEach((material) => material.dispose());
    this.assetInstanceMaterials.length = 0;
    for (const handle of this.assetHandles) handle.release();
    this.assetHandles.length = 0;
    this.assetRoot.clear();
    this.assetCpuBytes = surfaceTextureMemoryEstimate.cpuBytes;
    this.assetGpuBytes = surfaceTextureMemoryEstimate.gpuBytes;
    this.assetManager?.purgeUnused();
  }

  private attachCatalogDiagnostics(handle: AssetHandle): void {
    handle.scene.userData.catalogBounds = handle.definition.bounds;
    handle.scene.userData.preloadGroup = handle.definition.preloadGroup;
    handle.scene.userData.memoryEstimate = handle.definition.memoryEstimate;
  }

  private refreshAssetMemoryEstimate(): void {
    const unique = new Map(this.assetHandles.map((handle) => [handle.id, handle.definition]));
    this.assetCpuBytes = surfaceTextureMemoryEstimate.cpuBytes
      + [...unique.values()].reduce((total, definition) => total + definition.memoryEstimate.cpuBytes, 0);
    this.assetGpuBytes = surfaceTextureMemoryEstimate.gpuBytes
      + [...unique.values()].reduce((total, definition) => total + definition.memoryEstimate.gpuBytes, 0);
  }

  private updateAssetGateBindings(openGateIds: readonly string[]): void {
    const open = new Set(openGateIds);
    for (const [object, encounterId] of this.assetGateBindings) object.visible = !open.has(encounterId);
  }

  private applyMaterialVariant(
    root: THREE.Object3D,
    variants: readonly { id: string; accent: string }[],
    variantId?: string,
  ): void {
    if (!variantId || variantId === 'base' || variantId === 'default') return;
    const semanticAccent: Record<string, string> = {
      'wall-run': '#4defff',
      vault: '#ff3569',
      mantle: '#ff3569',
      'no-traverse': '#ffb547',
    };
    const accent = variants.find((variant) => variant.id === variantId)?.accent ?? semanticAccent[variantId];
    const weathered = variantId === 'weathered';
    if (!accent && !weathered) return;
    const accentColor = accent ? new THREE.Color(accent) : null;
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const next = source.map((material) => {
        if (!(material instanceof THREE.MeshStandardMaterial)) return material;
        const shouldAccent = material.emissive.getHex() !== 0 || /(signal|cyan|red|amber|light|route)/i.test(material.name);
        if (!weathered && !shouldAccent) return material;
        const clone = material.clone();
        if (weathered) {
          clone.color.multiplyScalar(0.62);
          clone.roughness = Math.max(0.82, clone.roughness);
          clone.metalness *= 0.55;
        } else if (accentColor) {
          clone.color.copy(accentColor);
          clone.emissive.copy(accentColor);
        }
        this.assetInstanceMaterials.push(clone);
        return clone;
      });
      object.material = Array.isArray(object.material) ? next : next[0]!;
    });
  }

  private setupLighting(): void {
    const skyFill = new THREE.HemisphereLight('#6979b9', '#110e18', 0.82);
    const rim = new THREE.DirectionalLight('#56e9ff', 0.72);
    rim.position.set(-36, 22, -65);
    const duskBounce = new THREE.DirectionalLight('#ff4d7b', 0.38);
    duskBounce.position.set(28, 8, 34);

    this.sun.position.set(35, 58, 24);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -38;
    this.sun.shadow.camera.right = 38;
    this.sun.shadow.camera.top = 38;
    this.sun.shadow.camera.bottom = -38;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 125;
    this.sun.shadow.bias = -0.00012;
    this.sun.shadow.normalBias = 0.032;
    this.sun.target = this.sunTarget;
    this.scene.add(skyFill, rim, duskBounce, this.sun, this.sunTarget);

    const viewKey = new THREE.DirectionalLight('#d7edff', 1.55);
    viewKey.position.set(-2.8, 4.5, 3.2);
    const viewRim = new THREE.DirectionalLight('#ff426d', 0.9);
    viewRim.position.set(3.8, 0.5, -2);
    this.viewScene.add(new THREE.HemisphereLight('#86b8d4', '#0d1019', 0.82), viewKey, viewRim);
  }

  private setupEnvironmentMap(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const room = new RoomEnvironment();
    room.background = new THREE.Color('#101426');
    const target = pmrem.fromScene(room, 0.035);
    this.environmentTexture = target.texture;
    this.scene.environment = this.environmentTexture;
    this.scene.environmentIntensity = 0.52;
    this.viewScene.environment = this.environmentTexture;
    this.viewScene.environmentIntensity = 0.82;
    room.dispose();
    pmrem.dispose();
  }

  /**
   * Projects a world point into CSS pixel coordinates on the canvas, or null
   * when it sits behind or outside the view. Used to anchor damage numbers.
   */
  projectToScreen(position: Vec3): readonly [number, number] | null {
    this.projection.set(position[0], position[1], position[2]).project(this.camera);
    if (this.projection.z > 1 || Math.abs(this.projection.x) > 1.2 || Math.abs(this.projection.y) > 1.2) return null;
    const width = this.canvas.clientWidth || this.canvas.width;
    const height = this.canvas.clientHeight || this.canvas.height;
    return [(this.projection.x * 0.5 + 0.5) * width, (-this.projection.y * 0.5 + 0.5) * height];
  }

  private consumeEvents(events: readonly GameEvent[], playerId: number | undefined): void {
    if (this.settings.reducedMotion) return;
    for (const event of events) {
      if (event.kind === 'shot') this.addCameraImpulse(0.0075, event.id);
      // Only damage the player took shakes the camera. This used to compare against
      // a hardcoded `1`, which held only because the player is entity one.
      else if (event.kind === 'hit' && playerId !== undefined && (event.targetEntityId ?? event.entityId) === playerId) this.addCameraImpulse(0.026, event.id);
      else if (event.kind === 'grappleAttach') this.addCameraImpulse(0.008, event.id);
      else if (event.kind === 'grapplePull') this.addCameraImpulse(0.011, event.id);
      else if (event.kind === 'grappleRelease') this.addCameraImpulse(0.004, event.id);
    }
  }

  /** Dash has no discrete event, so the locomotion edge drives its camera kick. */
  private consumeLocomotionImpulse(snapshot: SimulationSnapshot): void {
    const locomotion = snapshot.player.locomotion;
    const previous = this.lastLocomotion;
    this.lastLocomotion = locomotion;
    if (this.settings.reducedMotion || locomotion !== 'dashing' || previous === 'dashing') return;
    this.addCameraImpulse(0.012, snapshot.tick);
  }

  private addCameraImpulse(amount: number, phase: number): void {
    this.cameraImpulse = Math.max(this.cameraImpulse, amount);
    this.cameraImpulsePhase = phase * 1.618;
  }

  private updateCamera(snapshot: SimulationSnapshot, deltaSeconds: number): void {
    this.camera.position.fromArray(snapshot.camera.position);
    this.camera.rotation.order = 'YXZ';
    const roll = this.cameraRoll(snapshot);
    const shake = this.settings.reducedMotion ? 0 : this.cameraImpulse * this.settings.shake;
    const shakeX = Math.sin(this.cameraImpulsePhase * 4.1 + snapshot.tick * 0.73) * shake;
    const shakeY = Math.cos(this.cameraImpulsePhase * 2.7 + snapshot.tick * 0.91) * shake * 0.72;
    this.camera.rotation.set(snapshot.camera.pitch + shakeX, snapshot.camera.yaw + shakeY, roll, 'YXZ');
    this.cameraImpulse = THREE.MathUtils.damp(this.cameraImpulse, 0, 17, deltaSeconds);
    // Widening with speed is the cue a movement game cannot do without: at 12 and at
    // 34 metres a second the frame was otherwise identical.
    const targetFov = snapshot.camera.fov + this.speedDrive(snapshot) * SPEED_FOV_KICK;
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 8, deltaSeconds);
    this.camera.updateProjectionMatrix();
  }

  /**
   * How hard the speed cues should push. Zero below a sprint, so ordinary movement is
   * unaffected, and suppressed while aiming, where a widening frame fights the zoom.
   */
  private speedDrive(snapshot: SimulationSnapshot): number {
    if (this.settings.reducedMotion) return 0;
    const ramp = (snapshot.player.speed - SPEED_CUE_START) / (SPEED_CUE_FULL - SPEED_CUE_START);
    return THREE.MathUtils.clamp(ramp, 0, 1) * (1 - THREE.MathUtils.clamp(snapshot.player.adsProgress, 0, 1));
  }

  private updateSun(snapshot: SimulationSnapshot): void {
    const [x, y, z] = snapshot.camera.position;
    this.sunTarget.position.set(x, y, z - 18);
    this.sun.position.set(x + 32, y + 54, z + 28);
  }

  private cameraRoll(snapshot: SimulationSnapshot): number {
    if (this.settings.reducedMotion) return 0;
    if (snapshot.player.locomotion === 'wall-running-left') return -0.105 * this.settings.cameraRoll;
    if (snapshot.player.locomotion === 'wall-running-right') return 0.105 * this.settings.cameraRoll;
    if (snapshot.player.locomotion === 'grappling') return Math.sin(snapshot.tick * 0.035) * 0.018 * this.settings.cameraRoll;
    return 0;
  }

  private resize = (): void => {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const pixelRatio = this.pixelRatio(width, height);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = width / height;
    this.viewCamera.updateProjectionMatrix();
    this.post?.setSize(width, height, pixelRatio);
    this.grapple?.resize(width * pixelRatio, height * pixelRatio);
  };

  private pixelRatio(width: number, height: number): number {
    const capScale = Math.min(1, Math.sqrt((1920 * 1080) / Math.max(1, width * height * window.devicePixelRatio ** 2)));
    return Math.max(0.5, window.devicePixelRatio * capScale * this.effectiveRenderScale());
  }

  private effectiveRenderScale(): number {
    return this.settings.renderScale * this.dynamicScale;
  }

  private dynamicResolutionEnabled(): boolean {
    return 'dynamicResolution' in this.settings ? this.settings.dynamicResolution : false;
  }

  private updateDynamicResolution(frameMs: number): void {
    if (!this.dynamicResolutionEnabled()) {
      this.resolution.reset();
      return;
    }
    const previous = this.dynamicScale;
    this.dynamicScale = this.resolution.sample(frameMs);
    if (previous !== this.dynamicScale) this.resize();
  }
}
