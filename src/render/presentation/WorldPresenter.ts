import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { LevelPrimitive, LightInstance, RuntimeLevelV1, TransformData, Vec3 } from '../../contracts';
import { isAssetId } from '../assets/catalog';
import { MaterialLibrary } from './MaterialLibrary';

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

const CYAN = '#42e8ff';
const MAGENTA = '#ff3e77';
const AMBER = '#ffb547';

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
      const material = this.cityGlow.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = 1.35 + Math.sin(time * 0.28) * 0.12;
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

    if (primitive.gateForEncounterId) this.buildGate(group, sx, sy, sz);
    else if (sy <= 1.5 && (sx > 5 || sz > 5)) this.buildDeck(group, sx, sy, sz, primitive.surface);
    else if (sy >= Math.max(sx, sz) * 0.6) this.buildWall(group, sx, sy, sz, primitive.surface);
    else if (primitive.id.includes('grapple') || primitive.surface === 'no-traverse') this.buildAnchor(group, sx, sy, sz);
    else this.buildCover(group, sx, sy, sz, primitive.surface);
    return group;
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
    const stripMaterial = this.emissiveMaterial(accent, 3.8);
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

    const light = this.rounded(faceOnZ ? faceWidth * 0.72 : 0.055, 0.065, faceOnZ ? 0.055 : faceWidth * 0.72, 0.018, this.emissiveMaterial(this.surfaceColor(surface), 4.2));
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

  private buildEnvironment(): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(420, 40, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          zenith: { value: new THREE.Color('#080b1d') },
          dusk: { value: new THREE.Color('#51244e') },
          horizon: { value: new THREE.Color('#ec6a72') },
          nadir: { value: new THREE.Color('#070b13') },
        },
        vertexShader: 'varying vec3 vWorld; void main(){vWorld=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader: 'varying vec3 vWorld;uniform vec3 zenith;uniform vec3 dusk;uniform vec3 horizon;uniform vec3 nadir;void main(){float h=normalize(vWorld).y;vec3 c=h>0.0?mix(horizon,mix(dusk,zenith,smoothstep(.1,.88,h)),smoothstep(0.,.28,h)):mix(horizon,nadir,smoothstep(0.,-.38,h));gl_FragColor=vec4(c,1.);}',
      }),
    );
    this.environmentRoot.add(sky);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(400, 64), this.materials.get('carbon'));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -18, -85);
    floor.receiveShadow = true;
    this.environmentRoot.add(floor);

    const towerGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.04);
    const towerMaterial = this.materials.variant('armor', '#111724');
    this.generatedMaterials.push(towerMaterial);
    const towers = new THREE.InstancedMesh(towerGeometry, towerMaterial, 78);
    const windowGeometry = new THREE.PlaneGeometry(1, 1);
    const windowMaterial = this.emissiveMaterial('#ff507d', 1.45);
    const windows = new THREE.InstancedMesh(windowGeometry, windowMaterial, 78);
    const matrix = new THREE.Matrix4();
    const windowMatrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    let seed = 0xf10a5e7;
    const random = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    for (let index = 0; index < towers.count; index += 1) {
      const side = index % 2 ? -1 : 1;
      const width = 9 + random() * 18;
      const depth = 8 + random() * 22;
      const height = 25 + random() * 105;
      position.set(side * (42 + random() * 120), height / 2 - 18, 48 - random() * 285);
      scale.set(width, height, depth);
      matrix.compose(position, quaternion, scale);
      towers.setMatrixAt(index, matrix);
      const glowScale = new THREE.Vector3(width * 0.6, Math.max(4, height * 0.055), 1);
      const glowPosition = position.clone().add(new THREE.Vector3(side > 0 ? -width / 2 - 0.05 : width / 2 + 0.05, height * 0.18, 0));
      const glowQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, side > 0 ? -Math.PI / 2 : Math.PI / 2, 0));
      windowMatrix.compose(glowPosition, glowQuat, glowScale);
      windows.setMatrixAt(index, windowMatrix);
      windows.setColorAt(index, new THREE.Color(index % 3 ? '#36cfee' : '#ff4d7d'));
    }
    towers.instanceMatrix.needsUpdate = true;
    windows.instanceMatrix.needsUpdate = true;
    if (windows.instanceColor) windows.instanceColor.needsUpdate = true;
    windows.frustumCulled = true;
    towers.receiveShadow = true;
    this.cityGlow = windows;
    this.environmentRoot.add(towers, windows);

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

  private emissiveMaterial(color: THREE.ColorRepresentation, intensity: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.3, metalness: 0.35, toneMapped: false });
    this.generatedMaterials.push(material);
    return material;
  }

  private surfaceColor(surface: LevelPrimitive['surface']): string {
    if (surface === 'wall-run') return CYAN;
    if (surface === 'vault' || surface === 'mantle') return MAGENTA;
    if (surface === 'no-traverse') return AMBER;
    return '#7ddbe8';
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
