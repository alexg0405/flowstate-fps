import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LevelPrimitive, LightInstance, RuntimeLevelV1, TransformData, Vec3 } from '../../contracts';
import { isAssetId } from '../assets/catalog';
import { palette } from '../palette';
import { MaterialLibrary } from './MaterialLibrary';
import { FACE_BLEND } from './facePaint';
import { facadeAt, facadePatterns, paneLayout, towerArchetypes, towerTones, type FacadePattern } from './citySkyline';
import { skyFragmentShader, SKY_STOPS } from './skyGradient';

interface GateArt {
  group: THREE.Group;
  closedY: number;
  height: number;
}

/**
 * Authored accent lights are assigned to a fixed pool rather than all being live.
 *
 * Every light three.js can see enters the uniform arrays and the per-fragment loop of
 * every lit material, whichever direction the player is facing. White Line authored
 * eight of them along a 172 m corridor with ranges of 13 to 28 m, so most were tens or
 * hundreds of metres out of reach and still being paid for -- one sat 161 m away with a
 * 25 m range.
 *
 * The pool size is fixed for the level rather than the lights being toggled, because
 * three.js rebuilds shader programs when the light *count* changes, and doing that
 * while running would trade a steady cost for a hitch every time one came into range.
 */
const POOLED_POINT_LIGHTS = 2;
const POOLED_SPOT_LIGHTS = 1;

/**
 * How many airships, aircars and searchlights the sky carries, and how far their
 * lanes run before they wrap.
 *
 * The counts and the spans are one decision, not two. This is a corridor between
 * tower walls, so the visible sky is a slot maybe forty degrees wide: sky traffic
 * spread evenly over a few hundred metres is almost never inside it. The lanes are
 * therefore short and the traffic dense, so something is crossing the slot most of
 * the time rather than once a minute.
 */
const AIRSHIP_COUNT = 7;
const TRAFFIC_COUNT = 46;
const AIRSHIP_SPAN = 300;
/** Metres one tile of the deck seam and hazard patterns covers, in world units. */
const SEAM_TILE_METRES = 4;
const HAZARD_TILE_METRES = 1.1;
const TRAFFIC_SPAN = 330;

interface Airship { length: number; altitude: number; z: number; speed: number; phase: number; bob: number; tint: string }
/**
 * `axis` is which way the lane runs. `x` lanes cross the corridor and are read as
 * traffic passing overhead; `z` lanes run along it, above the route, and are the ones
 * a player actually watches while moving -- they come at you or pull away from you.
 */
interface Aircar { axis: 'x' | 'z'; altitude: number; offset: number; speed: number; phase: number; scale: number; tint: string }

interface SkyTraffic {
  hulls: THREE.InstancedMesh;
  banners: THREE.InstancedMesh;
  lamps: THREE.InstancedMesh;
  cars: THREE.InstancedMesh;
  airships: Airship[];
  traffic: Aircar[];
}

/** Position on a looping lane of `span` metres, centred on the origin. */
function wrapSpan(value: number, span: number): number {
  return ((value % span) + span * 1.5) % span - span / 2;
}

/** Screens wash toward white, so they read as lit panels rather than flat neon. */
const WHITE = new THREE.Color('#ffffff');
const CYAN = palette.cyan;
const MAGENTA = palette.red;
const YELLOW = palette.yellow;

export class WorldPresenter {
  readonly root = new THREE.Group();
  readonly environmentRoot = new THREE.Group();
  private readonly architectureRoot = new THREE.Group();
  private readonly propRoot = new THREE.Group();
  private readonly lightRoot = new THREE.Group();
  private readonly collisionDebugRoot = new THREE.Group();
  private readonly gates = new Map<string, GateArt>();
  /** Authored definitions, and the pool of lamps they are assigned to each frame. */
  private lightSources: LightInstance[] = [];
  private readonly lightGateBinding = new Map<string, string>();
  private readonly pointPool: THREE.PointLight[] = [];
  private readonly spotPool: THREE.SpotLight[] = [];
  private readonly generatedMaterials: THREE.Material[] = [];
  private readonly generatedTextures: THREE.Texture[] = [];
  private cityGlow?: THREE.InstancedMesh;
  private cityBeacons?: THREE.InstancedMesh;
  private sky?: SkyTraffic;
  /** Reused every frame by `updateSkyTraffic`, which is on the render path. */
  private readonly scratch = {
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    orientation: new THREE.Quaternion(),
    euler: new THREE.Euler(),
    color: new THREE.Color(),
  };

  constructor(private readonly materials: MaterialLibrary) {
    this.root.name = 'CyberDuskWorld';
    this.collisionDebugRoot.visible = false;
    this.root.add(this.architectureRoot, this.propRoot, this.lightRoot, this.collisionDebugRoot);
    this.buildEnvironment();
  }

  loadLevel(level: RuntimeLevelV1): void {
    this.clearGenerated(this.architectureRoot);
    this.clearGenerated(this.propRoot);
    this.clearGenerated(this.lightRoot);
    this.clearGenerated(this.collisionDebugRoot);
    this.gates.clear();
    this.lightSources = [];
    this.lightGateBinding.clear();

    // Unknown catalog entries must never hide the diagnostic proxy art.
    const alignedCollisionIds = new Set(level.visuals
      .filter((visual) => isAssetId(visual.assetId))
      .map((visual) => visual.collisionAlignmentId)
      .filter((id): id is string => Boolean(id)));
    const primitives = level.primitives;
    for (const primitive of primitives) {
      if (!alignedCollisionIds.has(primitive.id)) {
        const art = this.createArchitecture(primitive);
        art.userData.levelId = primitive.id;
        art.userData.surface = primitive.surface;
        art.userData.gateForEncounterId = primitive.gateForEncounterId;
        this.architectureRoot.add(art);
        if (primitive.gateForEncounterId) {
          this.gates.set(primitive.id, {
            group: art,
            closedY: art.position.y,
            height: primitive.transform.scale[1],
          });
        }
      }
      this.collisionDebugRoot.add(this.createCollisionProxy(primitive));
    }

    if ('visuals' in level) {
      const gateIdByEncounter = new Map(
        level.primitives
          .filter((primitive) => primitive.gateForEncounterId)
          .map((primitive) => [primitive.gateForEncounterId!, primitive.id] as const),
      );
      this.lightSources = [...level.lights];
      for (const light of level.lights) {
        if (!light.gateVisibilityBindingId) continue;
        this.lightGateBinding.set(
          light.id,
          gateIdByEncounter.get(light.gateVisibilityBindingId) ?? light.gateVisibilityBindingId,
        );
      }
      this.buildLightPool();
    }

    this.buildDeckMarkings(level.primitives);
    this.propRoot.add(this.createExitPortal(level.exit));
    level.encounters.forEach((encounter, index) => {
      this.propRoot.add(this.createWayfindingTotem(encounter.label, encounter.checkpoint, index + 1));
    });
  }

  update(time: number, openGateIds: readonly string[], cameraPosition?: Vec3): void {
    const open = new Set(openGateIds);
    for (const [id, gate] of this.gates) {
      const targetY = open.has(id) ? gate.closedY + gate.height + 1.1 : gate.closedY;
      gate.group.position.y = THREE.MathUtils.damp(gate.group.position.y, targetY, 8, 1 / 60);
      gate.group.visible = gate.group.position.y < gate.closedY + gate.height + 0.9;
    }
    if (cameraPosition) this.assignLightPool(cameraPosition, open);
    if (this.cityGlow) {
      const material = this.cityGlow.material as THREE.MeshToonMaterial;
      material.emissiveIntensity = 1.35 + Math.sin(time * 0.28) * 0.12;
    }
    this.updateSkyTraffic(time);
    if (this.cityBeacons) {
      // Warning beacons blink rather than glow. Slower than the neon and much
      // harder-edged, because that difference is the whole read.
      const material = this.cityBeacons.material as THREE.MeshToonMaterial;
      material.emissiveIntensity = Math.sin(time * 1.7) > 0.35 ? 3.4 : 0.35;
    }
  }

  /**
   * Lamps are created once with a constant count. Unused slots idle at zero intensity
   * rather than being hidden, which keeps the shader permutation stable.
   */
  private buildLightPool(): void {
    this.pointPool.length = 0;
    this.spotPool.length = 0;
    for (let index = 0; index < POOLED_POINT_LIGHTS; index += 1) {
      const lamp = new THREE.PointLight('#ffffff', 0, 1, 1.7);
      // V2 accent lights are intentionally non-shadowed; the sun remains the one
      // authored shadow source for predictable integrated-GPU cost.
      lamp.castShadow = false;
      this.pointPool.push(lamp);
      this.lightRoot.add(lamp);
    }
    for (let index = 0; index < POOLED_SPOT_LIGHTS; index += 1) {
      const lamp = new THREE.SpotLight('#ffffff', 0, 1, Math.PI / 5, 0.55, 1.5);
      lamp.castShadow = false;
      this.spotPool.push(lamp);
      this.lightRoot.add(lamp, lamp.target);
    }
  }

  /** Assigns the nearest reachable authored lights of each kind to the pool. */
  private assignLightPool(cameraPosition: Vec3, openGates: ReadonlySet<string>): void {
    if (this.pointPool.length === 0 && this.spotPool.length === 0) return;
    const reach = (light: LightInstance): number => {
      const [x, y, z] = light.transform.position;
      const distance = Math.hypot(x - cameraPosition[0], y - cameraPosition[1], z - cameraPosition[2]);
      // Negative means the player is inside the light's range; the most negative wins.
      return distance - light.range;
    };
    const eligible = this.lightSources.filter((light) => {
      const gate = this.lightGateBinding.get(light.id);
      return !(gate && openGates.has(gate));
    });
    this.fillPool(this.pointPool, eligible.filter((light) => light.kind === 'point'), reach);
    this.fillPool(this.spotPool, eligible.filter((light) => light.kind === 'spot'), reach);
  }

  private fillPool(
    pool: readonly (THREE.PointLight | THREE.SpotLight)[],
    candidates: readonly LightInstance[],
    reach: (light: LightInstance) => number,
  ): void {
    const ranked = [...candidates].sort((a, b) => reach(a) - reach(b));
    pool.forEach((lamp, slot) => {
      const source = ranked[slot];
      // Out of reach entirely is the same as having no candidate: keep the slot in the
      // light list, contributing nothing.
      if (!source || reach(source) > 0) {
        lamp.intensity = 0;
        return;
      }
      lamp.position.fromArray(source.transform.position);
      lamp.color.set(source.color);
      lamp.intensity = Math.min(source.intensity, 80);
      lamp.distance = source.range;
      if (lamp instanceof THREE.SpotLight) {
        lamp.angle = source.coneAngle ?? Math.PI / 5;
        lamp.penumbra = source.penumbra ?? 0.55;
        const direction = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(...source.transform.rotation));
        lamp.target.position.copy(lamp.position).add(direction);
      }
    });
  }

  setCollisionDebug(visible: boolean): void {
    this.collisionDebugRoot.visible = visible;
  }

  dispose(): void {
    this.clearGenerated(this.root);
    this.clearGenerated(this.environmentRoot);
    this.generatedMaterials.forEach((material) => material.dispose());
    this.generatedTextures.forEach((texture) => texture.dispose());
    this.generatedMaterials.length = 0;
    this.generatedTextures.length = 0;
  }

  private createArchitecture(primitive: LevelPrimitive): THREE.Group {
    const group = new THREE.Group();
    const [sx, sy, sz] = primitive.transform.scale;
    group.position.fromArray(primitive.transform.position);
    group.rotation.set(...primitive.transform.rotation);

    // A primitive with no collider is not route furniture: the simulation never built a
    // body for it and the nav bake excluded it, so it exists only to be looked at. Those
    // are composition masses -- the enormous background architecture the art direction
    // needs and the route cannot afford to make walkable -- and they get the skyline's
    // treatment rather than a deck's.
    if (!primitive.collision) this.buildMassif(group, sx, sy, sz, primitive.color);
    else if (primitive.gateForEncounterId) this.buildGate(group, sx, sy, sz);
    else if (sy <= 1.5 && (sx > 5 || sz > 5)) this.buildDeck(group, sx, sy, sz, primitive.surface);
    else if (sy >= Math.max(sx, sz) * 0.6) this.buildWall(group, sx, sy, sz, primitive.surface);
    else if (primitive.id.includes('grapple') || primitive.surface === 'no-traverse') this.buildAnchor(group, sx, sy, sz);
    else this.buildCover(group, sx, sy, sz, primitive.surface);
    return group;
  }

  /**
   * A mass that is only ever looked at.
   *
   * This is the same treatment the skyline gets, applied to an authored position instead
   * of a seeded one. The skyline is 180 towers scattered by `random()` between 29 and
   * 190 m off the route, which makes it *dressing*: there is no way to say "that mass,
   * that big, exactly there", and a composition is precisely a set of statements of that
   * form. A level can now make them, and the cost of one is a merged box stack and a
   * sheet of panes.
   *
   * Three things carry the read, and none of them is lighting:
   *
   * - **Face painting at `mass` hardness.** Four sides, four flat decisions, a hard edge
   *   between them. Without this a background mass is a grey box, because the procedural
   *   architecture path is the one place in the renderer that was never painted -- route
   *   primitives get their painting through the catalogued art batched over them, and a
   *   mass has no catalogued art to wear.
   * - **A setback.** One step in near the top. A plain extruded box reads as a wall at any
   *   size; a box that steps reads as a building, and it is two triangles' difference.
   * - **Sparse panes.** Windows are what turn a silhouette into something with a
   *   *distance*. Budgeted off the face area rather than fixed, so a 200 m tower is not
   *   lit like a 30 m one, and capped so a mass can never cost more than a few hundred
   *   quads.
   */
  private buildMassif(group: THREE.Group, sx: number, sy: number, sz: number, color: string): void {
    // Vertex colours arrive through the paint, so the material's own colour is white and
    // the tone the level authored rides on the geometry.
    const material = this.materials.build('architecture', { color, vertexColors: true });
    this.generatedMaterials.push(material);

    // A shaft with one setback near the crown. Kept to two blocks: this is background,
    // and the silhouette is doing the work rather than the detail.
    const shaftHeight = sy * 0.88;
    const shaft = new THREE.BoxGeometry(sx, shaftHeight, sz);
    shaft.translate(0, shaftHeight / 2 - sy / 2, 0);
    const crown = new THREE.BoxGeometry(sx * 0.68, sy - shaftHeight, sz * 0.68);
    crown.translate(0, sy / 2 - (sy - shaftHeight) / 2, 0);
    const merged = mergeGeometries([shaft, crown], false) ?? shaft;
    this.materials.paintFaces(merged, FACE_BLEND.mass);
    const mesh = new THREE.Mesh(merged, material);
    mesh.receiveShadow = true;
    group.add(mesh);

    // Panes on the two faces that can be seen from the route: the one pointing at it and
    // the one pointing back up it. Which those are is not knowable here, so both of the
    // wide faces get them and the narrow ones go dark, which is also what a real curtain
    // wall does.
    const paneMaterial = this.emissiveMaterial('#ffd9a3', 1.05);
    const faceWidth = Math.max(sx, sz);
    const pattern: FacadePattern = facadePatterns[Math.floor(faceWidth + sy) % facadePatterns.length];
    // Budgeted from the mass's own area at roughly a storey per cell, rather than from a
    // flat count. A flat 220 spread over a 26 by 96 m face gives cells eight metres tall,
    // which on the skyline is invisible and on a mass thirteen metres from the player is a
    // wall of pale rectangles the size of a garage door -- the single worst-reading thing
    // in the regenerated baseline. Storey-scaled cells mean a near mass gets many small
    // windows, like a building, and a far one gets the same ones too small to count.
    const STOREY = 3.6;
    const BAY = 2.4;
    const budget = Math.min(260, Math.max(24, Math.round((faceWidth / BAY) * (sy / STOREY))));
    const layout = paneLayout(pattern, budget, faceWidth, sy);
    const cellWidth = faceWidth / layout.columns;
    const cellHeight = sy / layout.rows;
    const panes = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      paneMaterial,
      Math.max(1, layout.columns * layout.rows * 2),
    );
    panes.count = 0;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(cellWidth * layout.fillWidth, cellHeight * layout.fillHeight, 1);
    // Deterministic, because a composition that reshuffles its own windows between two
    // screenshots is not a composition anyone can iterate on.
    let seed = Math.round(sx * 31 + sy * 17 + sz * 7);
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    let slot = 0;
    for (const side of [1, -1]) {
      const onZ = sz <= sx;
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), onZ ? (side > 0 ? 0 : Math.PI) : side * Math.PI / 2);
      for (let row = 0; row < layout.rows; row += 1) {
        // The setback takes the wall in, so a pane above it would float off the side.
        const height = (row + 0.5) / layout.rows;
        const block = facadeAt([{ y0: 0, y1: 0.88, width: 1, depth: 1 }, { y0: 0.88, y1: 1, width: 0.68, depth: 0.68 }], height);
        for (let column = 0; column < layout.columns; column += 1) {
          if (random() > layout.litChance) continue;
          const across = (-faceWidth / 2 + (column + 0.5) * cellWidth) * block.width;
          const depth = (onZ ? sz : sx) / 2 * block.depth + 0.05;
          position.set(
            onZ ? across * side : side * depth,
            -sy / 2 + (row + 0.5) * cellHeight,
            onZ ? side * depth : across * -side,
          );
          panes.setMatrixAt(slot, matrix.compose(position, quaternion, scale));
          slot += 1;
        }
      }
    }
    panes.count = slot;
    panes.instanceMatrix.needsUpdate = true;
    group.add(panes);
  }

  private buildDeck(group: THREE.Group, sx: number, sy: number, sz: number, surface: LevelPrimitive['surface']): void {
    const slab = this.rounded(sx, Math.max(0.16, sy * 0.48), sz, 0.08, this.materials.get('deck'));
    slab.position.y = sy * 0.22;
    slab.receiveShadow = true;
    group.add(slab);

    const top = this.rounded(sx * 0.985, 0.075, sz * 0.985, 0.025, this.materials.get('concrete'));
    top.position.y = sy * 0.5 - 0.03;
    top.receiveShadow = true;
    group.add(top);

    const accent = this.surfaceColor(surface);
    const railMaterial = this.materials.variant('gunmetal', '#111820');
    this.generatedMaterials.push(railMaterial);
    const stripMaterial = this.emissiveMaterial(accent, 1.9);
    const longAxisX = sx >= sz;
    const segments = Math.max(2, Math.min(10, Math.floor((longAxisX ? sx : sz) / 4)));
    for (let index = 0; index < segments; index += 1) {
      const span = (longAxisX ? sx : sz) / segments;
      const trim = this.rounded(longAxisX ? span * 0.7 : 0.055, 0.055, longAxisX ? 0.055 : span * 0.7, 0.018, stripMaterial);
      if (longAxisX) trim.position.set(-sx / 2 + span * (index + 0.5), sy * 0.38, sz / 2 + 0.012);
      else trim.position.set(sx / 2 + 0.012, sy * 0.38, -sz / 2 + span * (index + 0.5));
      group.add(trim);
    }

    const ribCount = Math.max(2, Math.min(8, Math.floor(sz / 3)));
    for (let index = 0; index < ribCount; index += 1) {
      const z = -sz / 2 + ((index + 0.5) / ribCount) * sz;
      const rib = this.rounded(Math.min(sx * 0.72, 6), sy * 0.3, 0.11, 0.035, railMaterial);
      rib.position.set(0, -sy * 0.33, z);
      rib.castShadow = true;
      group.add(rib);
    }
  }

  private buildWall(group: THREE.Group, sx: number, sy: number, sz: number, surface: LevelPrimitive['surface']): void {
    const wall = this.rounded(sx * 0.72, sy, sz * 0.72, Math.min(0.12, sx * 0.12, sz * 0.12), this.materials.get('concrete'));
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);

    const faceOnZ = sz <= sx;
    const faceWidth = faceOnZ ? sx : sz;
    const columns = Math.max(1, Math.min(7, Math.floor(faceWidth / 3)));
    const rows = Math.max(1, Math.min(5, Math.floor(sy / 2.8)));
    const panelMaterial = this.materials.variant('armor', surface === 'wall-run' ? '#163e49' : '#252f3a');
    this.generatedMaterials.push(panelMaterial);
    const panelWidth = faceWidth / columns * 0.82;
    const panelHeight = sy / rows * 0.78;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const panel = this.rounded(
          faceOnZ ? panelWidth : 0.075,
          panelHeight,
          faceOnZ ? 0.075 : panelWidth,
          0.045,
          panelMaterial,
        );
        const across = -faceWidth / 2 + (column + 0.5) * (faceWidth / columns);
        panel.position.set(faceOnZ ? across : (sx / 2 + 0.02), -sy / 2 + (row + 0.5) * (sy / rows), faceOnZ ? (sz / 2 + 0.02) : across);
        panel.castShadow = true;
        group.add(panel);
      }
    }

    const light = this.rounded(faceOnZ ? faceWidth * 0.72 : 0.055, 0.065, faceOnZ ? 0.055 : faceWidth * 0.72, 0.018, this.emissiveMaterial(this.surfaceColor(surface), 2.0));
    light.position.set(faceOnZ ? 0 : sx / 2 + 0.08, sy * 0.34, faceOnZ ? sz / 2 + 0.08 : 0);
    group.add(light);
  }

  private buildCover(group: THREE.Group, sx: number, sy: number, sz: number, surface: LevelPrimitive['surface']): void {
    const body = this.rounded(sx * 0.9, sy * 0.92, sz * 0.88, Math.min(0.2, sx * 0.08, sy * 0.08, sz * 0.08), this.materials.get('armor'));
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const frameMaterial = this.materials.get('gunmetal');
    for (const side of [-1, 1]) {
      const brace = this.rounded(0.09, sy * 0.82, sz * 0.96, 0.03, frameMaterial);
      brace.position.x = side * sx * 0.43;
      group.add(brace);
    }
    const inset = this.rounded(sx * 0.62, sy * 0.48, 0.055, 0.035, this.materials.get('carbon'));
    inset.position.z = -sz * 0.45 - 0.03;
    group.add(inset);
    const chevron = this.createChevron(this.surfaceColor(surface), Math.min(1.8, sx * 0.52), Math.min(0.45, sy * 0.16));
    chevron.position.set(0, sy * 0.2, -sz * 0.46 - 0.07);
    group.add(chevron);
  }

  private buildAnchor(group: THREE.Group, sx: number, sy: number, sz: number): void {
    const core = this.rounded(sx * 0.76, sy * 0.72, sz * 0.76, Math.min(0.22, sx * 0.13, sy * 0.13, sz * 0.13), this.materials.get('gunmetal'));
    core.castShadow = true;
    group.add(core);
    const cageMaterial = this.materials.get('carbon');
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      const strut = this.rounded(0.08, sy * 0.9, 0.08, 0.025, cageMaterial);
      strut.position.set(x * sx * 0.42, 0, z * sz * 0.42);
      group.add(strut);
    }
    const beacon = new THREE.Mesh(new THREE.TorusGeometry(Math.min(sx, sz) * 0.24, 0.045, 7, 24), this.materials.get('cyan-light'));
    beacon.rotation.x = Math.PI / 2;
    beacon.position.y = sy * 0.38;
    group.add(beacon);
  }

  private buildGate(group: THREE.Group, sx: number, sy: number, sz: number): void {
    const shell = this.rounded(sx, sy, Math.max(0.34, sz), 0.12, this.materials.get('gunmetal'));
    shell.castShadow = true;
    group.add(shell);
    const panelCount = Math.max(3, Math.min(12, Math.floor(sx / 2.5)));
    for (let index = 0; index < panelCount; index += 1) {
      const panelWidth = sx / panelCount * 0.78;
      const panel = this.rounded(panelWidth, sy * 0.78, Math.max(0.09, sz * 0.6), 0.06, index % 2 ? this.materials.get('armor') : this.materials.get('armor-red'));
      panel.position.x = -sx / 2 + (index + 0.5) * (sx / panelCount);
      panel.position.z = -sz * 0.3;
      group.add(panel);
      const seam = this.rounded(0.035, sy * 0.65, 0.035, 0.01, this.materials.get('red-light'));
      seam.position.set(panel.position.x + panelWidth * 0.46, 0, -sz * 0.64);
      group.add(seam);
    }
    const header = this.rounded(Math.min(8, sx * 0.55), 0.28, Math.max(0.4, sz * 1.5), 0.07, this.materials.get('carbon'));
    header.position.y = sy * 0.37;
    group.add(header);
  }

  private createCatalogPrefab(assetId: string, transform: TransformData, variant?: string): THREE.Group {
    const group = new THREE.Group();
    group.name = `Prefab:${assetId}`;
    group.position.fromArray(transform.position);
    group.rotation.set(...transform.rotation);
    group.scale.fromArray(transform.scale);
    if (/sign|holo/i.test(assetId)) group.add(this.createHolographicSign(assetId));
    else if (/vent|duct/i.test(assetId)) group.add(this.createVent());
    else if (/cable/i.test(assetId)) group.add(this.createCableBundle());
    else if (/anchor|grapple/i.test(assetId)) this.buildAnchor(group, 1.4, 1.4, 1.4);
    else if (/rail/i.test(assetId)) group.add(this.createRail());
    else {
      const material = variant ? this.materials.variant('armor', variant) : this.materials.get('armor');
      if (variant) this.generatedMaterials.push(material);
      const body = this.rounded(1, 1, 1, 0.12, material);
      const core = this.rounded(0.58, 0.58, 1.08, 0.08, this.materials.get('cyan-light'));
      group.add(body, core);
    }
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return group;
  }

  /**
   * The neon skyline.
   *
   * A tier of towers each side of the route, a far tier behind it for depth, and
   * gantries overhead so the upper half of the frame is not empty sky.
   *
   * Two things decide whether this reads as a city or as a field of boxes, and the
   * first version of it got both wrong:
   *
   * - **Every tower was the same building.** One `RoundedBoxGeometry(1, 1, 1)` was
   *   instanced 180 times and varied only by `scale`, so height and width were the
   *   entire vocabulary. Towers now come in six masses -- setbacks, overhanging
   *   crowns, podiums, twinned shafts, ziggurats -- defined as block stacks in
   *   `citySkyline.ts` and merged into one geometry each. Cost is one draw call per
   *   archetype, not per building. They also carry a little yaw, because a skyline
   *   perfectly aligned to the world axes reads as a tech demo.
   * - **Only one wall was ever lit.** Panes were placed on the single face pointing
   *   at the route, leaving the other three bare -- and the corridor-facing wall is
   *   the one the player sees most while running the route. Both faces are lit now,
   *   and the panes follow the block profile, so a setback steps its windows in with
   *   it instead of leaving them hanging in the air.
   *
   * What makes a facade read as a *building* is lit windows, and lots of them. They
   * are instanced quads sized in world units rather than a texture on the tower
   * material, because an instanced mesh shares one material: a mapped grid would
   * stretch across a 150 m tower and squash on a 12 m one, while world-sized quads
   * keep the same storey height on every building. The same reasoning puts the
   * billboards, masts and beacons in their own instanced meshes.
   */
  private buildCity(): void {
    const random = this.seededRandom(0xf10a5e7);
    const matrix = new THREE.Matrix4();
    const upright = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    const euler = new THREE.Euler();

    const tiers = [
      // Near tier: fills the dead band beside the route, and tall enough to close the
      // corridor in. Low frontage left the upper half of the frame as empty sky.
      // Weighted toward the solid masses -- a wall of twinned shafts and podiums
      // leaves gaps the corridor used to be closed by, and this is the tier doing
      // that job. The exotic silhouettes read better on the skyline anyway.
      { count: 96, minX: 29, spreadX: 32, minHeight: 20, spreadHeight: 52, minWidth: 7, spreadWidth: 9, panes: 34, shapes: [0, 0, 1, 1, 2, 5] },
      // Far tier: the skyline behind it. More panes because the whole facade is in
      // frame at that distance, and a grid of lights is what makes it read as a city.
      { count: 84, minX: 62, spreadX: 128, minHeight: 34, spreadHeight: 130, minWidth: 10, spreadWidth: 20, panes: 58, shapes: [0, 1, 2, 3, 4, 5] },
    ];
    const total = tiers.reduce((sum, tier) => sum + tier.count, 0);

    // Each tower is planned before anything is allocated, because an instanced mesh
    // needs its count up front and the archetypes are chosen at random.
    interface Plan {
      archetype: number; tone: number; side: number; x: number; z: number; yaw: number;
      width: number; depth: number; height: number; pattern: FacadePattern; panes: number; near: boolean;
    }
    const plans: Plan[] = [];
    for (const tier of tiers) {
      for (let index = 0; index < tier.count; index += 1) {
        const side = index % 2 ? -1 : 1;
        plans.push({
          archetype: tier.shapes[Math.floor(random() * tier.shapes.length) % tier.shapes.length],
          tone: Math.floor(random() * towerTones.length) % towerTones.length,
          side,
          width: tier.minWidth + random() * tier.spreadWidth,
          depth: tier.minWidth + random() * tier.spreadWidth,
          height: tier.minHeight + random() * tier.spreadHeight,
          x: side * (tier.minX + random() * tier.spreadX),
          z: 56 - random() * 300,
          // Small: enough to break the axis alignment, not enough to read as rubble.
          yaw: (random() - 0.5) * 0.34,
          pattern: facadePatterns[Math.floor(random() * facadePatterns.length) % facadePatterns.length],
          panes: tier.panes,
          near: tier.minX < 40,
        });
      }
    }

    // Plain boxes rather than rounded ones: an archetype is four or five blocks, so
    // rounding every one of them would multiply the skyline's triangle count for a
    // bevel that is sub-pixel at these distances. Measured, this is cheaper than the
    // single rounded box it replaces.
    // White, because the actual albedo arrives per instance through `setColorAt`:
    // one material for six archetypes and six building tones. Three bands rather than the
    // armour plate's five -- a tower is a plane, not a figure -- and vertex colours on,
    // because the faces are painted rather than lit. See `facePaint`.
    const towerMaterial = this.materials.build('architecture', { color: '#ffffff', vertexColors: true });
    this.generatedMaterials.push(towerMaterial);
    const archetypeMeshes = towerArchetypes.map((archetype) => {
      const count = plans.filter((plan) => towerArchetypes[plan.archetype] === archetype).length;
      const geometry = mergeGeometries(archetype.blocks.map((block) => {
        const box = new THREE.BoxGeometry(block.width, block.y1 - block.y0, block.depth);
        box.translate(block.offsetX ?? 0, (block.y0 + block.y1) / 2 - 0.5, block.offsetZ ?? 0);
        return box;
      }), false);
      // Which way each face points, decided once at build time and multiplied over
      // whatever light the tower receives afterwards. This is what turns a stack of
      // boxes into a mass with a lit side, a shadow side and a crown. At `mass` hardness,
      // because a tower is exactly the stack of boxes the hard rule is written for.
      const painted = geometry ?? new THREE.BoxGeometry(1, 1, 1);
      this.materials.paintFaces(painted, FACE_BLEND.mass);
      const mesh = new THREE.InstancedMesh(painted, towerMaterial, Math.max(1, count));
      mesh.receiveShadow = true;
      mesh.count = 0;
      return mesh;
    });

    // Three bands per tower, so a face reads as a lit building rather than one stripe.
    const bandsPerTower = 3;
    const bandGeometry = new THREE.PlaneGeometry(1, 1);
    const bandMaterial = this.emissiveMaterial(palette.cyan, 1.5);
    const bands = new THREE.InstancedMesh(bandGeometry, bandMaterial, total * bandsPerTower);

    // Storeys of lit windows, budgeted per tier and split across the two faces a
    // player can actually see: the one pointing at the route, and the one pointing
    // back up it.
    const paneBudget = tiers.reduce((sum, tier) => sum + tier.count * tier.panes, 0) * 2;
    const windowGeometry = new THREE.PlaneGeometry(1, 1);
    const windowMaterial = this.emissiveMaterial('#ffd9a3', 1.15);
    const windows = new THREE.InstancedMesh(windowGeometry, windowMaterial, paneBudget);
    windows.count = 0;

    const bannerGeometry = new THREE.PlaneGeometry(1, 1);
    const bannerMaterial = this.emissiveMaterial(palette.yellow, 1.7);
    bannerMaterial.map = this.signContentTexture();
    bannerMaterial.emissiveMap = bannerMaterial.map;
    const signs = new THREE.InstancedMesh(bannerGeometry, bannerMaterial, total);

    // Wide screens, the thing every reference photograph of a neon city is full of.
    // Only the near tier carries them; they are unreadable at far-tier distance.
    const billboardGeometry = new THREE.PlaneGeometry(1, 1);
    const billboardMaterial = this.emissiveMaterial('#f4f7ff', 1.25);
    billboardMaterial.map = this.signContentTexture();
    billboardMaterial.emissiveMap = billboardMaterial.map;
    const billboards = new THREE.InstancedMesh(billboardGeometry, billboardMaterial, total);

    // Roof masts. Cheap silhouette detail, and the reference skylines are full of them.
    const mastGeometry = new THREE.BoxGeometry(1, 1, 1);
    const mastMaterial = this.materials.variant('armor', '#0d131a');
    this.generatedMaterials.push(mastMaterial);
    const masts = new THREE.InstancedMesh(mastGeometry, mastMaterial, total);

    // Aircraft warning beacons on the tall ones. A red pinprick at the top of a
    // silhouette is most of what says "that is a building and it is very far away".
    const beaconGeometry = new THREE.SphereGeometry(1, 6, 4);
    const beaconMaterial = this.emissiveMaterial(palette.red, 2.4);
    const beacons = new THREE.InstancedMesh(beaconGeometry, beaconMaterial, total);

    const accents = [palette.cyan, palette.red, palette.yellow];
    // Windows are lamplight, not neon: warm office white with the odd cool or amber
    // floor. Uniform neon reads as a games-console skybox rather than a city.
    const windowTints = ['#ffd9a3', '#ffe9c8', '#c9e8ff', '#ff9a5c', '#8ff3ff'];
    const bandColor = new THREE.Color();
    let band = 0;
    let pane = 0;

    plans.forEach((plan, tower) => {
      const { blocks } = towerArchetypes[plan.archetype];
      const { side, width, depth, height, yaw, x, z } = plan;
      const baseY = height / 2 - 18;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      /** Tower-local X/Z to world, through the tower's own yaw. */
      const toWorld = (localX: number, localZ: number): [number, number] => [x + localX * cos + localZ * sin, z - localX * sin + localZ * cos];

      orientation.setFromEuler(euler.set(0, yaw, 0));
      const mesh = archetypeMeshes[plan.archetype];
      const slot = mesh.count;
      mesh.count = slot + 1;
      mesh.setMatrixAt(slot, matrix.compose(position.set(x, baseY, z), orientation, scale.set(width, height, depth)));
      mesh.setColorAt(slot, bandColor.set(towerTones[plan.tone]));

      const accent = accents[(tower * 3 + plan.archetype) % accents.length];

      /**
       * Places panes on one face of the tower. `axis` picks which wall: 'x' is the
       * one pointing across the route, 'z' the one pointing back along it. Both are
       * lit because both are visible from the corridor, and the offsets are read off
       * the block spanning each row so the grid follows a setback in.
       */
      const lightFace = (axis: 'x' | 'z', budget: number): void => {
        const sample = facadeAt(blocks, 0.4);
        const faceWidth = axis === 'x' ? depth * sample.depth : width * sample.width;
        const layout = paneLayout(plan.pattern, budget, faceWidth, height);
        const rowStep = (height * 0.88) / layout.rows;
        for (let row = 0; row < layout.rows; row += 1) {
          const t = (row + 0.5) / layout.rows * 0.9 + 0.04;
          const block = facadeAt(blocks, t);
          const halfWidth = (width * block.width) / 2;
          const halfDepth = (depth * block.depth) / 2;
          const acrossHalf = axis === 'x' ? halfDepth : halfWidth;
          const cell = (acrossHalf * 2) / layout.columns;
          for (let column = 0; column < layout.columns; column += 1) {
            if (pane >= paneBudget) return;
            if (random() > layout.litChance) continue;
            const across = -acrossHalf + (column + 0.5) * cell;
            // 0.06 m proud of the wall, so the quad never z-fights the mass behind it.
            const outward = axis === 'x'
              ? [(block.offsetX ?? 0) * width - side * (halfWidth + 0.06), (block.offsetZ ?? 0) * depth + across] as const
              : [(block.offsetX ?? 0) * width + across, (block.offsetZ ?? 0) * depth + halfDepth + 0.06] as const;
            const [worldX, worldZ] = toWorld(outward[0], outward[1]);
            orientation.setFromEuler(euler.set(0, yaw + (axis === 'x' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : 0), 0));
            windows.setMatrixAt(pane, matrix.compose(
              position.set(worldX, baseY - height / 2 + height * 0.06 + row * rowStep, worldZ),
              orientation,
              scale.set(cell * layout.fillWidth, rowStep * layout.fillHeight, 1),
            ));
            windows.setColorAt(pane, bandColor.set(windowTints[(tower * 7 + row * 3 + column) % windowTints.length]));
            pane += 1;
          }
        }
      };
      lightFace('x', plan.panes);
      lightFace('z', plan.panes);
      windows.count = pane;

      // The route-facing wall carries the neon: bands, a banner and a screen.
      const inwardBlock = facadeAt(blocks, 0.45);
      const inwardHalf = (width * inwardBlock.width) / 2;
      const [inwardX, inwardZ] = toWorld((inwardBlock.offsetX ?? 0) * width - side * (inwardHalf + 0.07), (inwardBlock.offsetZ ?? 0) * depth);
      orientation.setFromEuler(euler.set(0, yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 0));

      for (let step = 0; step < bandsPerTower; step += 1, band += 1) {
        const bandHeight = Math.max(0.35, height * (0.012 + random() * 0.02));
        const bandT = 0.18 + step * 0.26 + random() * 0.08;
        const bandBlock = facadeAt(blocks, bandT);
        const [bandX, bandZ] = toWorld((bandBlock.offsetX ?? 0) * width - side * ((width * bandBlock.width) / 2 + 0.07), (bandBlock.offsetZ ?? 0) * depth);
        bands.setMatrixAt(band, matrix.compose(
          position.set(bandX, baseY - height / 2 + height * bandT, bandZ),
          orientation,
          scale.set(depth * bandBlock.depth * (0.5 + random() * 0.4), bandHeight, 1),
        ));
        bandColor.set(step === 1 ? accent : accents[(tower + step) % accents.length]);
        bands.setColorAt(band, bandColor);
      }

      // A tall thin sign on roughly half the towers, which is what gives a skyline
      // its vertical rhythm.
      const hasSign = random() > 0.5;
      signs.setMatrixAt(tower, matrix.compose(
        position.set(inwardX, baseY + height * (0.1 + random() * 0.2), inwardZ),
        orientation,
        scale.set(Math.max(0.4, width * 0.1), hasSign ? height * (0.2 + random() * 0.3) : 0, 1),
      ));
      signs.setColorAt(tower, bandColor.set(accents[tower % accents.length]));

      // A screen on a third of the near-tier towers, wide and low on the facade.
      const screened = plan.near && random() > 0.66;
      const screenWidth = screened ? Math.max(2.6, depth * (0.5 + random() * 0.3)) : 0;
      billboards.setMatrixAt(tower, matrix.compose(
        position.set(inwardX, baseY - height / 2 + height * (0.3 + random() * 0.34), inwardZ),
        orientation,
        scale.set(screenWidth, screened ? screenWidth * (0.5 + random() * 0.3) : 0, 1),
      ));
      billboards.setColorAt(tower, bandColor.set(accents[(tower + 1) % accents.length]).lerp(WHITE, 0.55));

      // Masts on the taller half, so the skyline has a ragged top edge.
      const topBlock = facadeAt(blocks, 0.99);
      const masted = height > 46;
      const [mastX, mastZ] = toWorld((topBlock.offsetX ?? 0) * width, (topBlock.offsetZ ?? 0) * depth);
      masts.setMatrixAt(tower, matrix.compose(
        position.set(mastX, baseY + height / 2 + (masted ? height * 0.09 : 0), mastZ),
        upright,
        scale.set(masted ? 0.32 : 0, masted ? height * 0.18 : 0, masted ? 0.32 : 0),
      ));

      const beaconed = masted && random() > 0.35;
      beacons.setMatrixAt(tower, matrix.compose(
        position.set(mastX, baseY + height / 2 + (beaconed ? height * 0.185 : 0), mastZ),
        upright,
        scale.setScalar(beaconed ? 0.5 : 0),
      ));
    });

    // Gantries crossing the route overhead: the upper half of the frame was empty sky.
    // Kept few, high and thin -- this is a rooftop route, and a dense low lattice reads
    // as a tunnel ceiling instead.
    const gantryCount = 13;
    const gantryGeometry = new RoundedBoxGeometry(1, 1, 1, 1, 0.05);
    const gantryMaterial = this.materials.variant('armor', '#0c1219');
    this.generatedMaterials.push(gantryMaterial);
    const gantries = new THREE.InstancedMesh(gantryGeometry, gantryMaterial, gantryCount);
    for (let index = 0; index < gantryCount; index += 1) {
      const z = 24 - index * 24 - random() * 10;
      const y = 40 + random() * 44;
      const span = 80 + random() * 120;
      gantries.setMatrixAt(index, matrix.compose(
        position.set((random() - 0.5) * 34, y, z),
        orientation.setFromEuler(euler.set(0, 0, (random() - 0.5) * 0.14)),
        scale.set(span, 0.9 + random() * 1.6, 3 + random() * 4),
      ));
    }

    for (const mesh of [...archetypeMeshes, windows, bands, billboards, signs, masts, beacons, gantries]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.environmentRoot.add(mesh);
    }
    this.cityGlow = bands;
    this.cityBeacons = beacons;
  }

  /**
   * Markings on the play surfaces.
   *
   * The decks were bare. Each one is a single 4x4 m `rooftop-platform.glb` scaled up
   * -- a 30x22 m arena floor is that one asset stretched 7.5 times in X and 5.5 in Z
   * -- and the surface sheet is mapped 0..1 across each face with no `repeat` set. So
   * the texture is stretched by the same factor: whatever detail it has is smeared to
   * invisibility on a big deck and crisp on a small barrier, and nothing else is drawn
   * on the floor at all.
   *
   * This lays two overlays over every walkable top face, and the thing that makes them
   * work is that their UVs are computed **in world metres at build time** rather than
   * inherited from the mesh they sit on. A seam is 2 m apart on the start floor and 2 m
   * apart on the final arena, whatever those decks are scaled by. Both are one merged
   * geometry, so the whole route's floor decoration costs two draw calls.
   */
  private buildDeckMarkings(primitives: readonly LevelPrimitive[]): void {
    const decks = primitives.filter((primitive) => primitive.kind === 'box'
      && !primitive.gateForEncounterId
      && (primitive.surface === 'default')
      // A deck is wide, deep and thin. Walls and cover are boxes too.
      && primitive.transform.scale[0] >= 3
      && primitive.transform.scale[2] >= 3
      && primitive.transform.scale[1] <= 2.5);
    if (decks.length === 0) return;

    const seams = { position: [] as number[], uv: [] as number[], index: [] as number[] };
    const hazard = { position: [] as number[], uv: [] as number[], index: [] as number[] };
    /** One quad, with its UVs already in the units the texture tiles in. */
    const quad = (
      target: typeof seams,
      centreX: number, y: number, centreZ: number, halfX: number, halfZ: number,
      uPerMetre: number, vPerMetre: number, worldUv: boolean,
    ): void => {
      const base = target.position.length / 3;
      const corners: readonly [number, number][] = [[-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ]];
      for (const [dx, dz] of corners) {
        target.position.push(centreX + dx, y, centreZ + dz);
        // World UVs keep the texel density identical on a 6 m platform and a 34 m
        // arena; local ones run 0..1 across the quad, for a strip that has to start
        // and end with the edge it follows.
        target.uv.push(
          worldUv ? (centreX + dx) * uPerMetre : (dx / halfX * 0.5 + 0.5) * halfX * 2 * uPerMetre,
          worldUv ? (centreZ + dz) * vPerMetre : (dz / halfZ * 0.5 + 0.5),
        );
      }
      target.index.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };

    for (const deck of decks) {
      const [px, py, pz] = deck.transform.position;
      const [sx, sy, sz] = deck.transform.scale;
      const halfX = sx / 2;
      const halfZ = sz / 2;
      // Just proud of the deck: enough to clear it, far too little to step onto.
      const top = py + sy / 2 + 0.02;
      quad(seams, px, top, pz, halfX, halfZ, 1 / SEAM_TILE_METRES, 1 / SEAM_TILE_METRES, true);

      // A hazard band inset from all four edges, which is what a rooftop with a drop
      // off it actually carries, and it tells the player where the deck ends.
      const band = Math.min(0.55, Math.min(halfX, halfZ) * 0.16);
      const inset = band * 0.9;
      const lengthU = 1 / HAZARD_TILE_METRES;
      quad(hazard, px, top + 0.002, pz - halfZ + inset, halfX - band, band / 2, lengthU, 1, false);
      quad(hazard, px, top + 0.002, pz + halfZ - inset, halfX - band, band / 2, lengthU, 1, false);
      quad(hazard, px - halfX + inset, top + 0.002, pz, band / 2, halfZ - band, 1, lengthU, false);
      quad(hazard, px + halfX - inset, top + 0.002, pz, band / 2, halfZ - band, 1, lengthU, false);
    }
    // The side strips run along Z, so their tiling axis is V rather than U.
    for (let index = 0; index < hazard.uv.length; index += 2) {
      const vertex = index / 2;
      if (vertex % 16 >= 8) [hazard.uv[index], hazard.uv[index + 1]] = [hazard.uv[index + 1], hazard.uv[index]];
    }

    const build = (source: typeof seams): THREE.BufferGeometry => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.position, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(source.uv, 2));
      geometry.setIndex(source.index);
      geometry.computeVertexNormals();
      return geometry;
    };

    // Unlit and alpha-masked: these are paint on a surface that is already lit, and
    // lighting them again would make the markings brighter than the deck they are on.
    const seamMaterial = new THREE.MeshBasicMaterial({
      color: '#05090e', transparent: true, opacity: 0.62, alphaMap: this.deckSeamTexture(),
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const hazardMaterial = new THREE.MeshBasicMaterial({
      color: palette.yellow, transparent: true, opacity: 0.5, alphaMap: this.deckHazardTexture(),
      depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    this.generatedMaterials.push(seamMaterial, hazardMaterial);

    const seamMesh = new THREE.Mesh(build(seams), seamMaterial);
    const hazardMesh = new THREE.Mesh(build(hazard), hazardMaterial);
    seamMesh.renderOrder = 1;
    hazardMesh.renderOrder = 2;
    this.propRoot.add(seamMesh, hazardMesh);
  }

  /**
   * Panel seams and bolt heads, as an alpha mask. Drawn white on
   * transparent because the material tints it: what this texture decides is *where*
   * the deck is marked, not what colour the mark is.
   */
  private deckSeamTexture(): THREE.Texture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.Texture();
    context.clearRect(0, 0, size, size);

    // No grime layer. Hard blots read as stains, and soft ones banded visibly -- an
    // eight-bit alpha ramp at the strength this wants quantises into contour rings,
    // which was worse than the bare deck it was meant to improve. The seams carry it.
    // A panel every half tile, with a lighter line splitting each panel again.
    context.globalAlpha = 0.85;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 3;
    for (const at of [0, size / 2]) {
      context.beginPath();
      context.moveTo(at + 1.5, 0); context.lineTo(at + 1.5, size);
      context.moveTo(0, at + 1.5); context.lineTo(size, at + 1.5);
      context.stroke();
    }
    context.globalAlpha = 0.3;
    context.lineWidth = 1.5;
    for (const at of [size / 4, (size * 3) / 4]) {
      context.beginPath();
      context.moveTo(at, 0); context.lineTo(at, size);
      context.moveTo(0, at); context.lineTo(size, at);
      context.stroke();
    }

    // Bolt heads down the main seams.
    context.globalAlpha = 0.7;
    context.fillStyle = '#ffffff';
    for (let step = 0; step < 8; step += 1) {
      const along = 16 + step * 32;
      for (const at of [2, size / 2 + 2]) {
        context.fillRect(at - 2, along - 2, 5, 5);
        context.fillRect(along - 2, at - 2, 5, 5);
      }
    }

    context.globalAlpha = 1;
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    this.generatedTextures.push(texture);
    return texture;
  }

  /** Diagonal hazard hatching for the deck edges. One band, tiled along the edge. */
  private deckHazardTexture(): THREE.Texture {
    const width = 64;
    const height = 32;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.Texture();
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#ffffff';
    // Sheared bars rather than a rotated fill, so the pattern tiles seamlessly.
    for (let index = -1; index < 3; index += 1) {
      const x = index * 32;
      context.beginPath();
      context.moveTo(x, height);
      context.lineTo(x + 16, height);
      context.lineTo(x + 16 + height, 0);
      context.lineTo(x + height, 0);
      context.closePath();
      context.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    this.generatedTextures.push(texture);
    return texture;
  }

  /**
   * What is in the air.
   *
   * The sky above the route was empty except for gantries, which meant the upper
   * third of the frame did nothing while the player was looking up mid-grapple. Three
   * things fill it, and all of them move:
   *
   * - **Airships.** Slow, huge and lit: a dark hull with an advertising banner down
   *   each flank and a third across the belly, so one passing overhead is the loudest
   *   thing in the sky.
   * - **Air traffic.** Fast light streaks crossing between the towers on fixed lanes.
   *   Nothing about them is legible, and that is the point -- what registers is that
   *   the city is busy above the player as well as beside them.
   * - **Searchlights.** Slow cones sweeping from far rooftops.
   *
   * All of it is instanced -- six draw calls for the whole sky -- and all of it is
   * driven off the render clock, which `GameRenderer` pins to a constant under
   * `visualRegression`. That is what keeps the pixel baselines deterministic with
   * moving geometry in frame.
   */
  private buildSkyTraffic(): void {
    const random = this.seededRandom(0x5c_1e_a1);

    // Airships. The hull is one merged geometry so a ship costs no more to draw than
    // a box: an ellipsoid, a tail cross and a gondola slung under the nose.
    const hullParts = [
      new THREE.SphereGeometry(1, 14, 9).scale(1, 0.33, 0.33),
      new THREE.BoxGeometry(0.34, 0.46, 0.05).translate(-0.84, 0.3, 0),
      new THREE.BoxGeometry(0.34, 0.46, 0.05).translate(-0.84, -0.3, 0),
      new THREE.BoxGeometry(0.34, 0.05, 0.66).translate(-0.84, 0, 0),
      new THREE.BoxGeometry(0.52, 0.15, 0.19).translate(0.08, -0.36, 0),
    ];
    const hullGeometry = mergeGeometries(hullParts, false) ?? hullParts[0];
    const hullMaterial = this.materials.variant('armor', '#161d26');
    this.generatedMaterials.push(hullMaterial);
    const hulls = new THREE.InstancedMesh(hullGeometry, hullMaterial, AIRSHIP_COUNT);

    // Three banners a ship: both flanks and the belly, which is the one a player
    // running underneath actually reads.
    // Unlit rather than emissive, and the difference matters: a standard material's
    // emissive term is not multiplied by the instance colour, so a per-ship tint on
    // one would have been drowned by the material's own glow and every banner in the
    // sky would have come out the same white. These are screens; they are their own
    // light source and want no shading at all.
    const bannerGeometry = new THREE.PlaneGeometry(1, 1);
    const bannerMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff', map: this.signContentTexture(), side: THREE.DoubleSide, toneMapped: false,
    });
    this.generatedMaterials.push(bannerMaterial);
    const banners = new THREE.InstancedMesh(bannerGeometry, bannerMaterial, AIRSHIP_COUNT * 3);

    // Gondola glow and the nose and tail lamps, merged into one emissive piece.
    const lampParts = [
      new THREE.BoxGeometry(0.44, 0.05, 0.21).translate(0.08, -0.4, 0),
      new THREE.SphereGeometry(0.07, 6, 4).translate(1.0, 0, 0),
      new THREE.SphereGeometry(0.07, 6, 4).translate(-1.0, 0.32, 0),
    ];
    const lampGeometry = mergeGeometries(lampParts, false) ?? lampParts[0];
    const lampMaterial = new THREE.MeshBasicMaterial({ color: '#ffe0b0', toneMapped: false });
    this.generatedMaterials.push(lampMaterial);
    const lamps = new THREE.InstancedMesh(lampGeometry, lampMaterial, AIRSHIP_COUNT);

    const accents = [palette.cyan, palette.red, palette.yellow, '#ff7ad9', '#8ff3ff'];
    const airships: Airship[] = [];
    for (let index = 0; index < AIRSHIP_COUNT; index += 1) {
      airships.push({
        length: 24 + random() * 30,
        altitude: 46 + random() * 44,
        // Kept in the near half of the route, where the corridor slot actually shows
        // sky. A ship 250 m out is behind a tower wall for its whole pass.
        z: -18 - random() * 150,
        // Half go each way, so the sky is not a conveyor belt.
        speed: (random() > 0.5 ? 1 : -1) * (2.4 + random() * 3.4),
        phase: random() * AIRSHIP_SPAN,
        bob: random() * Math.PI * 2,
        tint: accents[index % accents.length],
      });
    }

    // Air traffic. A bright head with a dim tail merged behind it reads as a streak
    // at this distance, and costs one instance rather than a particle system.
    const carParts = [
      new THREE.BoxGeometry(1, 0.22, 0.22),
      new THREE.BoxGeometry(3.4, 0.09, 0.09).translate(-2.2, 0, 0),
    ];
    const carGeometry = mergeGeometries(carParts, false) ?? carParts[0];
    const carMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
    this.generatedMaterials.push(carMaterial);
    const cars = new THREE.InstancedMesh(carGeometry, carMaterial, TRAFFIC_COUNT);
    const traffic: Aircar[] = [];
    for (let index = 0; index < TRAFFIC_COUNT; index += 1) {
      const outbound = index % 2 === 0;
      // Two thirds run along the corridor, above the route, because those are the
      // ones in frame while the player is moving down it.
      const axis = index % 3 === 0 ? 'x' : 'z';
      traffic.push({
        axis,
        // Lanes: a handful of altitudes rather than a uniform scatter, because real
        // traffic is stacked into levels and the stacking is what reads as a lane.
        // Above the gantries at 40-84 m for the along-route lanes, so they are not
        // constantly clipping through them.
        altitude: axis === 'z' ? 30 + (index % 4) * 22 + random() * 8 : 34 + (index % 5) * 16 + random() * 7,
        // For an x lane this is the z it crosses at; for a z lane it is the x it runs
        // along, kept inside the corridor's own width.
        offset: axis === 'x' ? -14 - random() * 150 : (random() - 0.5) * 46,
        speed: (outbound ? 1 : -1) * (30 + random() * 42),
        phase: random() * TRAFFIC_SPAN,
        scale: 1.1 + random() * 1.6,
        // Red going away, cool white coming toward: the same read as a motorway.
        tint: outbound ? '#ff2d55' : '#cfefff',
      });
    }

    for (const mesh of [hulls, banners, lamps, cars]) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.environmentRoot.add(mesh);
    }
    this.sky = { hulls, banners, lamps, cars, airships, traffic };
    this.updateSkyTraffic(0);
  }

  /**
   * Flies everything in the sky for this frame.
   *
   * Positions are a pure function of `time`, not integrated per frame, so a dropped
   * frame cannot make the sky drift out of step and `visualRegression`'s pinned clock
   * reproduces the same sky every capture.
   */
  private updateSkyTraffic(time: number): void {
    const sky = this.sky;
    if (!sky) return;
    const { matrix, position, scale, orientation, euler, color } = this.scratch;

    sky.airships.forEach((ship, index) => {
      // Wrapped through a span wider than the frame, so a ship leaves and returns
      // rather than popping in at the edge of view.
      const x = wrapSpan(ship.phase + time * ship.speed, AIRSHIP_SPAN);
      const y = ship.altitude + Math.sin(time * 0.11 + ship.bob) * 1.6;
      const heading = ship.speed > 0 ? 0 : Math.PI;
      const radius = ship.length * 0.33;
      orientation.setFromEuler(euler.set(0, heading, Math.sin(time * 0.07 + ship.bob) * 0.03));
      sky.hulls.setMatrixAt(index, matrix.compose(position.set(x, y, ship.z), orientation, scale.setScalar(ship.length / 2)));
      sky.lamps.setMatrixAt(index, matrix.compose(position.set(x, y, ship.z), orientation, scale.setScalar(ship.length / 2)));

      const bannerWidth = ship.length * 0.62;
      const bannerHeight = ship.length * 0.19;
      color.set(ship.tint);
      // Port, starboard, belly. The belly one lies flat and faces down. Written out
      // rather than built from a list, because this runs every frame for every ship
      // and a list of fresh Eulers and Vector3s here is garbage on the render path.
      for (let slot = 0; slot < 3; slot += 1) {
        const offsetY = slot === 2 ? -radius - 0.12 : 0;
        const offsetZ = slot === 0 ? radius + 0.12 : slot === 1 ? -radius - 0.12 : 0;
        euler.set(slot === 2 ? -Math.PI / 2 : 0, slot === 1 ? Math.PI : 0, 0);
        const target = index * 3 + slot;
        sky.banners.setMatrixAt(target, matrix.compose(
          position.set(x, y + offsetY, ship.z + offsetZ),
          orientation.setFromEuler(euler),
          scale.set(bannerWidth, bannerHeight, 1),
        ));
        sky.banners.setColorAt(target, color);
      }
    });

    sky.traffic.forEach((car, index) => {
      const along = wrapSpan(car.phase + time * car.speed, TRAFFIC_SPAN);
      // The merged geometry points down +X with its tail behind it, so an along-route
      // lane is the same shape yawed a quarter turn.
      const yaw = car.axis === 'x'
        ? (car.speed > 0 ? 0 : Math.PI)
        : (car.speed > 0 ? -Math.PI / 2 : Math.PI / 2);
      orientation.setFromEuler(euler.set(0, yaw, 0));
      const x = car.axis === 'x' ? along : car.offset;
      const z = car.axis === 'x' ? car.offset : along - TRAFFIC_SPAN / 2 + 40;
      sky.cars.setMatrixAt(index, matrix.compose(
        position.set(x, car.altitude, z),
        orientation,
        scale.setScalar(car.scale),
      ));
      sky.cars.setColorAt(index, color.set(car.tint));
    });

    for (const mesh of [sky.hulls, sky.banners, sky.lamps, sky.cars]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * A sign face: rows of glyph-sized blocks over a dark panel. It is deliberately
   * illegible -- at skyline distance what registers is that a panel has *content*,
   * and a flat rectangle of colour is exactly what does not.
   *
   * One texture shared by every screen and banner, tinted per instance, so the whole
   * city still draws in seven calls.
   */
  private signContentTexture(): THREE.Texture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.Texture();
    const random = this.seededRandom(0x51_9ace);
    context.fillStyle = '#12161d';
    context.fillRect(0, 0, size, size);
    for (let row = 0; row < 9; row += 1) {
      const y = 6 + row * 13;
      let x = 5 + random() * 10;
      while (x < size - 8) {
        const width = 4 + random() * 16;
        context.fillStyle = random() > 0.3 ? '#ffffff' : '#b9d8ff';
        context.globalAlpha = 0.35 + random() * 0.65;
        context.fillRect(x, y, Math.min(width, size - 8 - x), 7);
        x += width + 3 + random() * 7;
      }
    }
    context.globalAlpha = 1;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.generatedTextures.push(texture);
    return texture;
  }

  /** Deterministic, so the skyline is identical for every player and every capture. */
  private seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };
  }

  private buildEnvironment(): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(420, 40, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        // Stops and bands come from `skyGradient`, and so does the shader body, so the
        // gradient is one set of numbers that a test can measure rather than a literal
        // buried in a string.
        uniforms: {
          zenith: { value: new THREE.Color(SKY_STOPS.zenith.hex) },
          dusk: { value: new THREE.Color(SKY_STOPS.dusk.hex) },
          horizon: { value: new THREE.Color(SKY_STOPS.horizon.hex) },
          nadir: { value: new THREE.Color(SKY_STOPS.nadir.hex) },
        },
        vertexShader: 'varying vec3 vWorld; void main(){vWorld=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader: skyFragmentShader(),
      }),
    );
    this.environmentRoot.add(sky);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(400, 64), this.materials.get('carbon'));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -18, -85);
    floor.receiveShadow = true;
    this.environmentRoot.add(floor);

    this.buildCity();
    this.buildSkyTraffic();

    const moon = new THREE.Mesh(new THREE.SphereGeometry(14, 32, 20), this.emissiveMaterial('#ffadb9', 1.1));
    moon.position.set(-105, 96, -235);
    this.environmentRoot.add(moon);
  }

  private createExitPortal(position: Vec3): THREE.Group {
    const portal = new THREE.Group();
    portal.position.fromArray(position);
    const ringMaterial = this.materials.get('cyan-light');
    for (let index = 0; index < 3; index += 1) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.45 + index * 0.18, 0.055 - index * 0.012, 8, 40), ringMaterial);
      ring.position.y = 0.2;
      ring.rotation.y = index * 0.16;
      portal.add(ring);
    }
    const base = this.rounded(3.8, 0.22, 2.1, 0.08, this.materials.get('gunmetal'));
    base.position.y = -1.55;
    portal.add(base);
    return portal;
  }

  private createWayfindingTotem(label: string, checkpoint: Vec3, number: number): THREE.Group {
    const group = new THREE.Group();
    group.position.set(checkpoint[0] - 4.2, checkpoint[1] + 2.1, checkpoint[2] + 3.6);
    const post = this.rounded(0.12, 3.4, 0.12, 0.035, this.materials.get('gunmetal'));
    post.position.y = -0.25;
    const sign = this.createTextPanel(`${String(number).padStart(2, '0')}  ${label.toUpperCase()}`, 'SECTOR ACCESS // FORWARD');
    sign.position.set(0.95, 0.85, 0);
    group.add(post, sign);
    return group;
  }

  private createTextPanel(title: string, subtitle: string): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 224;
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0, 'rgba(4,11,20,.92)');
    gradient.addColorStop(1, 'rgba(17,35,50,.66)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#4beaff';
    context.lineWidth = 6;
    context.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
    context.fillStyle = '#61efff';
    context.fillRect(0, 0, 14, canvas.height);
    context.font = '700 52px system-ui';
    context.fillText(title, 48, 92);
    context.fillStyle = '#d3ebf1';
    context.font = '500 27px system-ui';
    context.fillText(subtitle, 50, 154);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.generatedTextures.push(texture);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, toneMapped: false });
    this.generatedMaterials.push(material);
    return new THREE.Mesh(new THREE.PlaneGeometry(4.7, 1.37), material);
  }

  private createHolographicSign(assetId: string): THREE.Mesh {
    return this.createTextPanel(assetId.replaceAll('-', ' ').toUpperCase(), 'WHITE LINE // TRANSIT SYSTEM');
  }

  private createVent(): THREE.Group {
    const group = new THREE.Group();
    group.add(this.rounded(1.6, 0.7, 1.2, 0.1, this.materials.get('gunmetal')));
    for (let index = 0; index < 5; index += 1) {
      const slat = this.rounded(1.15, 0.055, 0.06, 0.015, this.materials.get('carbon'));
      slat.position.set(0, -0.24 + index * 0.12, -0.62);
      group.add(slat);
    }
    return group;
  }

  private createCableBundle(): THREE.Group {
    const group = new THREE.Group();
    for (let index = 0; index < 5; index += 1) {
      const cable = new THREE.Mesh(new THREE.TorusGeometry(0.8 + index * 0.04, 0.018, 5, 24, Math.PI), index === 2 ? this.materials.get('cyan-light') : this.materials.get('carbon'));
      cable.rotation.z = Math.PI / 2;
      cable.position.x = index * 0.05;
      group.add(cable);
    }
    return group;
  }

  private createRail(): THREE.Group {
    const group = new THREE.Group();
    const top = this.rounded(3, 0.08, 0.08, 0.025, this.materials.get('gunmetal'));
    top.position.y = 0.8;
    group.add(top);
    for (const x of [-1.35, -0.45, 0.45, 1.35]) {
      const post = this.rounded(0.07, 0.85, 0.07, 0.02, this.materials.get('gunmetal'));
      post.position.set(x, 0.39, 0);
      group.add(post);
    }
    return group;
  }

  private createChevron(color: THREE.ColorRepresentation, width: number, height: number): THREE.Group {
    const group = new THREE.Group();
    const material = this.emissiveMaterial(color, 3.2);
    for (const side of [-1, 1]) {
      const bar = this.rounded(width * 0.55, height * 0.18, 0.025, 0.018, material);
      bar.rotation.z = side * 0.42;
      bar.position.x = side * width * 0.22;
      group.add(bar);
    }
    return group;
  }

  private createCollisionProxy(primitive: LevelPrimitive): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(...primitive.transform.scale);
    const material = new THREE.MeshBasicMaterial({ color: this.surfaceColor(primitive.surface), wireframe: true, transparent: true, opacity: 0.42 });
    this.generatedMaterials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.fromArray(primitive.transform.position);
    mesh.rotation.set(...primitive.transform.rotation);
    return mesh;
  }

  private rounded(x: number, y: number, z: number, radius: number, material: THREE.Material): THREE.Mesh {
    return new THREE.Mesh(new RoundedBoxGeometry(Math.max(0.01, x), Math.max(0.01, y), Math.max(0.01, z), 2, Math.max(0.001, Math.min(radius, x / 3, y / 3, z / 3))), material);
  }

  private emissiveMaterial(color: THREE.ColorRepresentation, intensity: number): THREE.MeshToonMaterial {
    const material = this.materials.build('emissive', { color, emissive: color, emissiveIntensity: intensity });
    this.generatedMaterials.push(material);
    return material;
  }

  private surfaceColor(surface: LevelPrimitive['surface']): string {
    if (surface === 'wall-run') return CYAN;
    if (surface === 'vault' || surface === 'mantle') return MAGENTA;
    if (surface === 'no-traverse') return YELLOW;
    // Plain decks carry the yellow the menu leads with, which the 3D layer had none of.
    return YELLOW;
  }

  private clearGenerated(root: THREE.Object3D): void {
    for (const child of [...root.children]) {
      root.remove(child);
      child.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) object.geometry.dispose();
      });
    }
  }
}
