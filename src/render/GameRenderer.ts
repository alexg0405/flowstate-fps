import * as THREE from 'three';
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
import { accentMaterial, canBatch, groupVisualBatches, resolveVariantAccent, type VariantAccent } from './presentation/visualBatching';
import { HitstopController } from './presentation/hitstop';
import { directCamera, FOV_DIRECTION, isTouchdown } from './presentation/cameraDirection';
import { botColliderBottom } from '../content/config';
import { ResonancePresenter } from './presentation/ResonancePresenter';
import { palette } from './palette';
import { ResolutionController } from './ResolutionController';
import { ViewmodelPresenter } from './presentation/ViewmodelPresenter';
import { WorldPresenter } from './presentation/WorldPresenter';

/** Speed at which the motion cues start, and where they reach full strength. */
const SPEED_CUE_START = 11;
const SPEED_CUE_FULL = 30;

/** A visual held back from the scene graph until the batching pass runs. */
interface BatchCandidate {
  handle: AssetHandle;
  visual: RuntimeLevelV1['visuals'][number];
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  frameMs: number;
  renderScale: number;
  assetCpuBytes: number;
  assetGpuBytes: number;
  /** Seconds of hitstop left on the presentation clock. Zero when nothing is frozen. */
  hitstopSeconds: number;
  /**
   * Total seconds the presentation clock has spent frozen. The instantaneous figure is
   * only ever a few frames wide, so it is close to unobservable from outside; the
   * running total is what says whether hitstop is firing at all and what fraction of
   * the run it is eating.
   */
  hitstopTotalSeconds: number;
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
  private readonly resonance: ResonancePresenter;
  private readonly post: PostPipeline;
  private readonly assetManager: AssetManager;
  private readonly assetRoot = new THREE.Group();
  // Cooled and pulled back. A warm 2.05 sun raking a pale deck is what made the floor
  // the brightest thing in frame; the accents are supposed to own that.
  private readonly sun = new THREE.DirectionalLight('#cfe4ee', 2.4);
  private readonly sunTarget = new THREE.Object3D();
  private resizeObserver: ResizeObserver;
  private settings: SaveDataV1['settings'];
  private lastFrameAt = performance.now();
  private dynamicScale = 1;
  private readonly resolution = new ResolutionController();
  private cameraImpulse = 0;
  private cameraImpulsePhase = 0;
  /** Decaying 0..1, set on the frame the player touches down. See `cameraDirection`. */
  private landingImpulse = 0;
  private readonly hitstop = new HitstopController();
  /**
   * The presentation clock, accumulated rather than read off the wall.
   *
   * Everything that animates -- the sky, the traffic, effect birthdays, the shaders --
   * is a function of this, so hitstop is simply a frame where it does not advance.
   * Reading `performance.now()` here instead, as this used to, would have left the
   * world drifting through a freeze.
   */
  private presentationTime = 0;
  private hitstopTotalSeconds = 0;
  private lastLocomotion: SimulationSnapshot['player']['locomotion'] | null = null;
  private readonly deterministicPresentation = new URLSearchParams(location.search).get('visualRegression') === '1';
  private disposed = false;
  private assetAbort: AbortController | null = null;
  private assetHandles: AssetHandle[] = [];
  private readonly assetGateBindings = new Map<THREE.Object3D, string>();
  private readonly assetInstanceMaterials: THREE.Material[] = [];
  private readonly batchedVisuals: THREE.BatchedMesh[] = [];
  private viewmodelHandle: AssetHandle | null = null;
  private assetCpuBytes = surfaceTextureMemoryEstimate.cpuBytes;
  private assetGpuBytes = surfaceTextureMemoryEstimate.gpuBytes;
  private readonly grappleEmitterOffset = new THREE.Vector3();
  private readonly projection = new THREE.Vector3();
  private authoredViewmodel: THREE.Object3D | null = null;
  private authoredViewmodelClips: readonly THREE.AnimationClip[] = [];

  /** The carried blade's accent, so the generated edge takes the style's identity. */
  setBladeAccent(accent: string): void {
    this.viewmodel.setBladeAccent(accent);
  }

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
    // No tone mapping *here*, which is the point. `PostPipeline` applies one authored
    // curve on the linear buffer instead -- see `toneCurve` for why a film curve and a
    // grade trying to undo it is two curves rather than none.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.scene.background = new THREE.Color(palette.void);
    this.scene.fog = new THREE.FogExp2(palette.ink, 0.0062);

    this.materials = new MaterialLibrary(this.renderer);
    this.world = new WorldPresenter(this.materials);
    this.characters = new CharacterPresenter(this.materials);
    this.characters.updateSettings(settings);
    this.viewmodel = new ViewmodelPresenter(this.materials, settings);
    this.fx = new FxPresenter(this.materials, settings);
    this.grapple = new GrapplePresenter(this.materials, settings);
    this.ghost = new GhostPresenter(settings);
    this.resonance = new ResonancePresenter(settings);
    this.assetRoot.name = 'Catalog Assets';
    this.scene.add(this.world.environmentRoot, this.world.root, this.assetRoot, this.characters.root, this.fx.root, this.grapple.root, this.grapple.aimRoot, this.ghost.root, this.resonance.root);
    this.viewScene.add(this.viewmodel.root);
    this.setupLighting();
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
    this.resonance.updateSettings(settings);
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
    const batchable: BatchCandidate[] = [];
    for (const visual of level.visuals) {
      if (!isAssetId(visual.assetId)) continue;
      const gateId = visual.gateVisibilityBindingId
        ? gateIdByEncounter.get(visual.gateVisibilityBindingId) ?? visual.gateVisibilityBindingId
        : undefined;
      assetLoads.push(this.loadVisualAsset(visual.assetId, visual, controller.signal, batchable, gateId));
    }
    await Promise.allSettled(assetLoads);
    if (this.disposed || controller.signal.aborted) return;
    this.batchVisualAssets(batchable);
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
    const realFrameSeconds = this.deterministicPresentation
      ? 0
      : Math.min(0.1, Math.max(1 / 240, (renderStarted - this.lastFrameAt) / 1000));
    this.lastFrameAt = renderStarted;

    const playerId = snapshot.entities[0]?.id;
    // Hitstop is a stopped presentation clock and nothing else: the simulation has
    // already stepped, and the snapshot it produced is still what gets drawn. What
    // freezes is every animation, every effect and the whole camera damping chain --
    // in first person the largest of those is the viewmodel, so a swing stopping dead
    // mid-arc is most of the read.
    const frozen = this.hitstop.update(events, playerId, realFrameSeconds, this.presentationMotionEnabled());
    const frameSeconds = frozen ? 0 : realFrameSeconds;
    if (frozen) this.hitstopTotalSeconds += realFrameSeconds;
    this.presentationTime += frameSeconds;
    const time = this.deterministicPresentation ? 12 : this.presentationTime;

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
    this.resonance.update(snapshot, time, botColliderBottom);

    this.post.setSpeed(this.speedDrive(snapshot));
    this.post.render(frameSeconds);
    const renderMs = performance.now() - renderStarted;
    // Fed the true frame delta, not the renderer's own slice of it: simulation, React
    // and compositing all land inside the budget the scale is protecting. And the
    // *real* delta rather than the frozen one -- hitstop is a stopped animation clock,
    // not a free frame, and reporting zero milliseconds through a freeze would have the
    // controller upscale into a stutter it caused itself.
    if (!this.deterministicPresentation) this.updateDynamicResolution(realFrameSeconds * 1000);
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      frameMs: renderMs,
      renderScale: this.effectiveRenderScale(),
      assetCpuBytes: this.assetCpuBytes,
      assetGpuBytes: this.assetGpuBytes,
      hitstopSeconds: this.hitstop.seconds,
      hitstopTotalSeconds: this.hitstopTotalSeconds,
    };
  }

  /**
   * Whether decorative motion may run at all. Reduced motion is a save-file toggle as
   * well as a media query, so it is checked here rather than left to the stylesheet --
   * and a player who turns it on mid-run has to be released from any live freeze,
   * which is why `HitstopController.update` is still called rather than skipped.
   */
  private presentationMotionEnabled(): boolean {
    return !this.settings.reducedMotion && !this.deterministicPresentation;
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
    this.resonance.dispose();
    this.grapple.dispose();
    this.fx.dispose();
    this.viewmodel.dispose();
    this.characters.dispose();
    this.world.dispose();
    this.materials.dispose();
    this.renderer.dispose();
    // `dispose()` frees three's own objects and leaves the WebGL context alive. A
    // browser caps how many of those exist at once -- Chromium at sixteen -- and it
    // kills the oldest to make room, so a session that enters and leaves a run enough
    // times loses the renderer out from under a run that is still using it. Handing the
    // context back is the only way to actually release it.
    this.renderer.forceContextLoss?.();
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
      this.assetInstanceMaterials.push(...this.materials.decorateImported(handle.scene, 'viewmodel'));
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
      // Hostiles shade in five steps where a wall shades in three: an enemy has to hold
      // its volume against an environment that is deliberately flat.
      this.assetInstanceMaterials.push(...this.materials.decorateImported(handle.scene, 'character'));
      // Two hunter GLBs are authored; `CharacterPresenter` draws the bulwark with the
      // brawler's and marks it out with its shield plate and accent.
      const profile = handle.id === 'character.hunter-aggressive' ? 'aggressive' : 'ranged';
      this.characters.setExternalTemplate(profile, handle.scene, handle.animations);
      this.assetHandles.push(handle);
    }
  }

  private async loadVisualAsset(
    id: AssetId,
    visual: RuntimeLevelV1['visuals'][number],
    signal: AbortSignal,
    batchable: BatchCandidate[],
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
    this.assetHandles.push(handle);
    // A gate binding toggles this instance's `visible` on its own, which a batch has
    // no equivalent for, so gated visuals stay whole. Everything else that can be
    // expressed as one geometry at many transforms goes to the batching pass instead
    // of being decorated and added an instance at a time.
    if (!gateId && canBatch(handle.scene)) {
      batchable.push({ handle, visual });
      return;
    }
    if (handle.source === 'gltf') this.assetInstanceMaterials.push(...this.materials.decorateImported(handle.scene, 'architecture'));
    this.applyMaterialVariant(handle.scene, handle.definition.variants, visual.materialVariantId);
    if (gateId) this.assetGateBindings.set(handle.scene, gateId);
    this.assetRoot.add(handle.scene);
  }

  /**
   * Catalog visuals used to be one draw call each: 35 instances of three to five
   * meshes came to 132 of the 252 main-pass draws, essentially one draw per mesh.
   * Grouping them takes the whole frame from 292 draws to 152 at the spawn view.
   *
   * `BatchedMesh` rather than `mergeGeometries`, and the deciding number was not the
   * draw count -- both win the same 18 batches -- but the geometry each submits:
   *
   * | spawn view / finish view | draws | triangles |
   * | unbatched                | 292 / 64 | 163,219 / 81,339 |
   * | merged or instanced      | 152 / 55 | 175,991 / 120,067 |
   * | `BatchedMesh`            | 152 / 55 | 163,219 / 81,339 |
   *
   * The audit expected per-instance culling to buy almost nothing on a 172 m
   * corridor. At the spawn view that is nearly true -- every asset mesh is in front
   * of the camera and drawn regardless. Standing at the finish with the route behind
   * you it is not: culling was skipping 38k triangles, and a batch culled as one unit
   * gives them all back. `BatchedMesh` keeps the per-instance test and still collapses
   * the calls, so it is the only option here that costs nothing to take.
   *
   * Each batch is one geometry drawn at many transforms, because instances of an
   * asset share the template's buffers -- `SkeletonUtils.clone` copies the nodes, not
   * the geometry. That also means one shared material per batch instead of the clone
   * per instance `decorateImported` and `applyMaterialVariant` used to make.
   *
   * The collapse itself needs `WEBGL_multi_draw`. Chromium and Safari have it; the
   * Firefox this repo tests against does not, and three falls back to a draw per
   * visible instance there -- the same count as before batching, with the per-instance
   * culling still applied. So the win is browser-dependent, but the fallback is not a
   * regression, which is why this and not the merged geometry the audit floated.
   */
  private batchVisualAssets(candidates: readonly BatchCandidate[]): void {
    const batches = groupVisualBatches(candidates.map(({ handle, visual }) => ({
      root: handle.scene,
      variant: resolveVariantAccent(handle.definition.variants, visual.materialVariantId),
    })));
    for (const batch of batches) {
      const vertexCount = batch.geometry.attributes.position?.count ?? 0;
      const indexCount = batch.geometry.index?.count ?? 0;
      // Painted before the material is built, because a material told to read vertex
      // colours from a geometry that has none renders black.
      const painted = this.materials.paintFaces(batch.geometry);
      const mesh = new THREE.BatchedMesh(batch.matrices.length, vertexCount, indexCount, this.batchMaterial(batch.material, batch.variant, painted));
      mesh.castShadow = batch.castShadow;
      mesh.receiveShadow = batch.receiveShadow;
      const geometryId = mesh.addGeometry(batch.geometry);
      for (const matrix of batch.matrices) mesh.setMatrixAt(mesh.addInstance(geometryId), matrix);
      // Culling reads the batch's own bounds; three leaves them null until asked.
      mesh.computeBoundingSphere();
      this.batchedVisuals.push(mesh);
      this.assetRoot.add(mesh);
    }
  }

  /** One shared material per batch, carrying the surface sheet and the variant accent. */
  private batchMaterial(source: THREE.Material, variant: VariantAccent, painted: boolean): THREE.Material {
    const decorated = this.materials.decorateMaterial(source, 'architecture', painted);
    const accented = accentMaterial(decorated, variant);
    if (accented) {
      // The decorated clone was only a stepping stone to the accented one.
      if (decorated !== source) decorated.dispose();
      this.assetInstanceMaterials.push(accented);
      return accented;
    }
    if (decorated !== source) this.assetInstanceMaterials.push(decorated);
    return decorated;
  }

  private releaseLevelAssets(): void {
    this.assetAbort?.abort('Level presentation replaced.');
    this.assetAbort = null;
    this.viewmodel.setExternalModel(null);
    this.characters.clearExternalTemplates();
    this.viewmodelHandle = null;
    this.assetGateBindings.clear();
    // Instanced batches own only their instance buffers; the geometry belongs to the
    // cached template and the materials are released with the rest below.
    this.batchedVisuals.forEach((mesh) => mesh.dispose());
    this.batchedVisuals.length = 0;
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
    const variant = resolveVariantAccent(variants, variantId);
    if (!variant.accent && !variant.weathered) return;
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const next = source.map((material) => {
        const clone = accentMaterial(material, variant);
        if (!clone) return material;
        this.assetInstanceMaterials.push(clone);
        return clone;
      });
      object.material = Array.isArray(object.material) ? next : next[0]!;
    });
  }

  /**
   * The rig, and it carries more than it used to because there is no longer an
   * environment probe under it.
   *
   * The hemisphere light is the important one now. Banded materials take their direct
   * light through a coloured ramp -- so the *terminator* is where a surface changes hue --
   * but a face inside a cast shadow receives no direct light at all, and what is left is
   * the ambient term. That makes this light the colour of every shadow in the game, which
   * is why its sky is a cold violet and its ground is a near-black teal rather than the
   * grey a renderer would default to.
   */
  private setupLighting(): void {
    const skyFill = new THREE.HemisphereLight('#3f4d8c', '#060d0e', 0.5);
    const rim = new THREE.DirectionalLight('#08f7ff', 1.5);
    rim.position.set(-36, 22, -65);
    const duskBounce = new THREE.DirectionalLight('#ff2d55', 0.85);
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

    const viewKey = new THREE.DirectionalLight('#d7edff', 2.1);
    viewKey.position.set(-2.8, 4.5, 3.2);
    const viewRim = new THREE.DirectionalLight('#ff426d', 1.2);
    viewRim.position.set(3.8, 0.5, -2);
    this.viewScene.add(new THREE.HemisphereLight('#86b8d4', '#101426', 1.1), viewKey, viewRim);
  }

  /**
   * Deliberately gone: `setupEnvironmentMap` built a PMREM probe from `RoomEnvironment`
   * and handed it to both scenes at 0.52 and 0.82 intensity. A banded material has no
   * specular response and samples no environment, so the probe became a render target and
   * a shader compile that nothing read. What it was contributing to the ambient term is
   * now carried by the hemisphere light in `setupLighting`, where it can be a colour
   * decision rather than a photograph of a room.
   */

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
      // A swing that connected punches harder than a shot; one that cut air does not
      // punch at all, so the kick is part of the confirmation rather than decoration.
      else if (event.kind === 'melee' && event.targetEntityId !== undefined) this.addCameraImpulse(0.02, event.id);
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
    if (this.settings.reducedMotion) return;
    // Touching down has no event either, and it is the one moment in the vocabulary that
    // compresses the frame rather than opening it.
    if (isTouchdown(previous, locomotion)) this.landingImpulse = 1;
    if (locomotion !== 'dashing' || previous === 'dashing') return;
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
    // Perspective as an animation system rather than one effect: speed widens the frame,
    // a hook widens it further, and a landing compresses it and snaps back. All of it is
    // an offset on the player's own setting, and none of it can move where a shot goes.
    // See `cameraDirection`.
    this.landingImpulse = Math.max(0, this.landingImpulse - FOV_DIRECTION.landingDecay * deltaSeconds);
    const direction = directCamera({
      drive: this.speedDrive(snapshot),
      locomotion: snapshot.player.locomotion,
      landing: this.landingImpulse,
      reducedMotion: this.settings.reducedMotion,
    });
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, snapshot.camera.fov + direction.offset, direction.damping, deltaSeconds);
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
    // A phone at a pixel ratio of three asks for more pixels than a 1080p desktop and has
    // a fraction of the fill rate to draw them with. Dynamic resolution would find this
    // on its own, but only after several seconds of a bad frame -- capping the target up
    // front is the difference between a run that starts well and a run that recovers.
    const budget = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 1280 * 720 : 1920 * 1080;
    const capScale = Math.min(1, Math.sqrt(budget / Math.max(1, width * height * window.devicePixelRatio ** 2)));
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
