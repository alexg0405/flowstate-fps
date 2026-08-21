import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { BotProfile, EntitySnapshot, GameEvent, SaveDataV1, SimulationSnapshot } from '../../contracts';
import { botColliderBottom } from '../../content/config';
import { hostileAccent } from '../palette';
import { MaterialLibrary, rebindGraphicShading } from './MaterialLibrary';
import { stepAdvance, steppedTime } from './animationStepping';

interface HunterInstance {
  root: THREE.Group;
  previous: THREE.Vector3;
  target: THREE.Vector3;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  chest: THREE.Group;
  head: THREE.Group;
  coat: THREE.Group;
  healthFill: THREE.Mesh;
  healthChip: THREE.Mesh;
  healthRoot: THREE.Group;
  healthFillMaterial: THREE.MeshBasicMaterial;
  healthFraction: number;
  chipFraction: number;
  ownedGeometries: THREE.BufferGeometry[];
  ownedMaterials: THREE.Material[];
  deathMaterials: THREE.Material[];
  profile: HostileProfile;
  dyingUntilTick: number;
  deathOrigin: THREE.Vector3;
  attackUntilTick: number;
  hitUntilTick: number;
  landUntilTick: number;
  wasGrounded: boolean;
  /** Seconds of animation owed but not yet worth a pose. See `animationStepping`. */
  poseDebt: number;
  external: boolean;
  mixer: THREE.AnimationMixer | null;
  actions: Map<string, THREE.AnimationAction>;
  currentClip: string | null;
  baseScale: number;
}

interface ExternalHunterTemplate {
  scene: THREE.Group;
  animations: readonly THREE.AnimationClip[];
}

interface HealthDisplay {
  group: THREE.Group;
  fill: THREE.Mesh;
  chip: THREE.Mesh;
  fillMaterial: THREE.MeshBasicMaterial;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

/** Which hostile is being drawn. Named once so a new profile is one edit, not nine. */
type HostileProfile = BotProfile['kind'];
/** The builds there is art for. */
type AuthoredBuild = 'ranged' | 'aggressive';

const DEATH_TICKS = 48;
const ATTACK_TICKS = 15;
const HIT_TICKS = 10;
const HEALTH_BAR_WIDTH = 1.15;
const HEALTH_BAR_HEIGHT = 0.115;
const HEALTH_HIGH = '#46e08a';
const HEALTH_MID = '#ffbf3d';
const HEALTH_LOW = '#ff3355';
/** Fraction of the bar the chip layer drains per second. */
const CHIP_DRAIN_PER_SECOND = 0.9;
const HEALTH_REFERENCE_DISTANCE = 14;
const HEALTH_MAX_SCALE = 2.6;
const ACCENT_EMISSIVE_INTENSITY = 0.14;

function profileAccent(profile: HostileProfile): string {
  return hostileAccent[profile];
}

/**
 * Which authored build a hostile is drawn with. Only two hunter GLBs exist, and a
 * third silhouette means regenerating the whole art pipeline, so the bulwark reuses
 * the brawler's -- what has to read at a glance is which way its plate is pointing,
 * and that is the plate's job. The narrow return type is deliberate: a fourth
 * profile falls back to a build that exists rather than to a missing template.
 */
function templateProfile(profile: HostileProfile): AuthoredBuild {
  return profile === 'ranged' ? 'ranged' : 'aggressive';
}

/** The equivalent angle in (-pi, pi], so a turn always takes the short way round. */
function shortestAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

/** Half-width, height and stand-off of the bulwark's plate, in metres. */
const SHIELD_PLATE = { width: 0.52, height: 0.94, offset: 0.42 } as const;
/** Only signal trim and optics carry the accent glow; armour stays dark. */
const ACCENT_MATERIAL = /(signal|glass|visor|optic)/i;

const LAND_TICKS = 8;

export class CharacterPresenter {
  readonly root = new THREE.Group();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly instances = new Map<number, HunterInstance>();
  private readonly templates = new Map<AuthoredBuild, THREE.Group>();
  private readonly externalTemplates = new Map<AuthoredBuild, ExternalHunterTemplate>();
  private readonly ownedMaterials: THREE.Material[] = [];

  constructor(private readonly materials: MaterialLibrary) {
    this.root.name = 'Corporate Hunters';
    this.templates.set('ranged', this.createTemplate('ranged'));
    this.templates.set('aggressive', this.createTemplate('aggressive'));
  }

  /**
   * Whether poses step. Off under reduced motion: stepping is a deliberate stylisation
   * rather than an accessibility measure, and a player who has asked for less motion
   * should not be handed a figure that moves in jumps.
   */
  private get stepping(): boolean {
    return this.stepPoses;
  }

  /** Set from the save on every settings change; see `stepping`. */
  private stepPoses = true;

  updateSettings(settings: SaveDataV1['settings']): void {
    this.stepPoses = !settings.reducedMotion;
    const outlinesVisible = !('graphicsQuality' in settings) || settings.graphicsQuality !== 'low';
    const update = (root: THREE.Object3D) => root.traverse((object) => {
      if (object.userData.characterOutline) object.visible = outlinesVisible;
    });
    update(this.root);
    for (const template of this.templates.values()) update(template);
  }

  setExternalTemplate(profile: AuthoredBuild, scene: THREE.Group, animations: readonly THREE.AnimationClip[]): void {
    this.externalTemplates.set(profile, { scene, animations });
    for (const [id, instance] of this.instances) {
      if (templateProfile(instance.profile) !== profile) continue;
      this.disposeInstance(instance);
      this.instances.delete(id);
    }
  }

  clearExternalTemplates(): void {
    this.externalTemplates.clear();
    for (const [id, instance] of this.instances) {
      if (!instance.external) continue;
      this.disposeInstance(instance);
      this.instances.delete(id);
    }
  }

  consume(events: readonly GameEvent[], _nowSeconds: number): void {
    for (const event of events) {
      // The telegraph is what the pose has to lead with; the attack that follows it
      // only extends the window, so a wind-up is visible before damage resolves.
      if (event.kind === 'enemyTelegraph' || event.kind === 'enemyAttack') {
        const id = event.sourceEntityId ?? event.entityId;
        if (id === undefined) continue;
        const hunter = this.instances.get(id);
        if (!hunter || hunter.dyingUntilTick > 0) continue;
        hunter.attackUntilTick = Math.max(hunter.attackUntilTick, event.tick + ATTACK_TICKS);
        if (hunter.external) this.playClip(hunter, this.attackClip(hunter), 0.06, false, true);
        continue;
      }
      if (event.kind === 'hit') {
        const id = event.targetEntityId ?? event.entityId;
        if (id === undefined) continue;
        const hunter = this.instances.get(id);
        if (!hunter || hunter.dyingUntilTick > 0) continue;
        hunter.hitUntilTick = Math.max(hunter.hitUntilTick, event.tick + HIT_TICKS);
        if (hunter.external) this.playClip(hunter, 'hunter_hit', 0.045, false, true);
        continue;
      }
      if (event.kind === 'kill') {
        const id = event.targetEntityId ?? event.entityId;
        if (id === undefined) continue;
        const hunter = this.instances.get(id);
        if (!hunter) continue;
        hunter.dyingUntilTick = event.tick + DEATH_TICKS;
        hunter.deathOrigin.copy(hunter.root.position);
        hunter.healthRoot.visible = false;
        this.isolateDeathMaterials(hunter);
        if (hunter.external) this.playClip(hunter, 'hunter_death', 0.08, false, true);
      }
    }
  }

  update(snapshot: SimulationSnapshot, time: number, deltaSeconds: number, interpolationAlpha: number): void {
    this.cameraPosition.fromArray(snapshot.camera.position);
    const live = new Set<number>();
    for (const entity of snapshot.entities) {
      if (entity.kind !== 'bot') continue;
      live.add(entity.id);
      let hunter = this.instances.get(entity.id);
      if (hunter?.dyingUntilTick) {
        this.disposeInstance(hunter);
        this.instances.delete(entity.id);
        hunter = undefined;
      }
      if (!hunter) {
        hunter = this.createInstance(entity);
        this.instances.set(entity.id, hunter);
        this.root.add(hunter.root);
      }
      this.updateHunter(hunter, entity, snapshot.tick, time, deltaSeconds, interpolationAlpha);
    }

    for (const [id, hunter] of this.instances) {
      if (live.has(id)) continue;
      if (hunter.dyingUntilTick > snapshot.tick) {
        const remaining = THREE.MathUtils.clamp((hunter.dyingUntilTick - snapshot.tick) / DEATH_TICKS, 0, 1);
        const progress = 1 - remaining;
        hunter.mixer?.update(deltaSeconds);
        hunter.root.rotation.z = progress * (hunter.profile === 'aggressive' ? -1.25 : 1.1);
        hunter.root.position.copy(hunter.deathOrigin);
        hunter.root.position.y -= progress * 0.4;
        hunter.root.scale.setScalar(hunter.baseScale * (0.82 + remaining * 0.18));
        for (const material of hunter.deathMaterials) {
          material.transparent = remaining < 0.65;
          material.opacity = Math.max(0.05, remaining / 0.65);
        }
        continue;
      }
      this.disposeInstance(hunter);
      this.instances.delete(id);
    }
  }

  dispose(): void {
    for (const hunter of this.instances.values()) this.disposeInstance(hunter);
    this.instances.clear();
    this.externalTemplates.clear();
    for (const template of this.templates.values()) {
      const geometries = new Set<THREE.BufferGeometry>();
      template.traverse((object) => {
        if (object instanceof THREE.Mesh) geometries.add(object.geometry);
      });
      geometries.forEach((geometry) => geometry.dispose());
    }
    this.templates.clear();
    this.ownedMaterials.forEach((material) => material.dispose());
    this.ownedMaterials.length = 0;
    this.root.clear();
  }

  private createInstance(entity: EntitySnapshot): HunterInstance {
    const profile = entity.profile ?? 'ranged';
    const drawnAs = templateProfile(profile);
    const external = this.externalTemplates.get(drawnAs);
    const root = external ? cloneSkeleton(external.scene) as THREE.Group : this.templates.get(drawnAs)!.clone(true);
    root.position.fromArray(entity.position);
    root.position.y -= botColliderBottom;
    root.rotation.y = entity.rotationY;
    let mixer: THREE.AnimationMixer | null = null;
    const actions = new Map<string, THREE.AnimationAction>();
    if (external) {
      mixer = new THREE.AnimationMixer(root);
      for (const clip of external.animations) actions.set(clip.name, mixer.clipAction(clip));
    }
    const health = this.createHealthDisplay(profile);
    root.add(health.group);
    const marker = this.createGroundMarker(profile);
    root.add(marker.mesh);
    health.geometries.push(marker.geometry);
    health.materials.push(marker.material);
    if (profile === 'bulwark') {
      // The plate is the affordance for the whole mechanic: the simulation only
      // scales down damage arriving in front of the bot, so the player has to be
      // able to see which way that is. It hangs off the model's forward axis, which
      // the simulation turns at the profile's own rate.
      const plate = this.createShieldPlate(profile);
      root.add(plate.mesh);
      health.geometries.push(...plate.geometries);
      health.materials.push(...plate.materials);
    }
    const target = new THREE.Vector3().fromArray(entity.position).setY(entity.position[1] - botColliderBottom);
    const instance: HunterInstance = {
      root,
      previous: target.clone(),
      target,
      leftArm: root.getObjectByName('left-arm') as THREE.Group,
      rightArm: root.getObjectByName('right-arm') as THREE.Group,
      leftLeg: root.getObjectByName('left-leg') as THREE.Group,
      rightLeg: root.getObjectByName('right-leg') as THREE.Group,
      chest: root.getObjectByName('chest-rig') as THREE.Group,
      head: (root.getObjectByName('head-rig') ?? root.getObjectByName('head')) as THREE.Group,
      coat: root.getObjectByName('coat-rig') as THREE.Group,
      healthFill: health.fill,
      healthChip: health.chip,
      healthRoot: health.group,
      healthFillMaterial: health.fillMaterial,
      healthFraction: 1,
      chipFraction: 1,
      ownedGeometries: health.geometries,
      ownedMaterials: health.materials,
      deathMaterials: [],
      profile,
      dyingUntilTick: 0,
      deathOrigin: target.clone(),
      attackUntilTick: 0,
      hitUntilTick: 0,
      landUntilTick: 0,
      wasGrounded: entity.grounded,
      poseDebt: 0,
      external: Boolean(external),
      mixer,
      actions,
      currentClip: null,
      baseScale: root.scale.x,
    };
    // Isolate materials up front so the accent cannot bleed across clones, and
    // reuse the same clones the death fade already relies on.
    this.isolateDeathMaterials(instance);
    this.applyProfileAccent(instance);
    if (external) this.playClip(instance, 'hunter_idle', 0, true);
    return instance;
  }

  private updateHunter(
    hunter: HunterInstance,
    entity: EntitySnapshot,
    tick: number,
    time: number,
    deltaSeconds: number,
    interpolationAlpha: number,
  ): void {
    const next = this.scratchPosition.fromArray(entity.position);
    next.y -= botColliderBottom;
    if (!next.equals(hunter.target)) {
      hunter.previous.copy(hunter.target);
      hunter.target.copy(next);
    }
    hunter.root.position.lerpVectors(hunter.previous, hunter.target, THREE.MathUtils.clamp(interpolationAlpha, 0, 1));
    // Damped along the shortest arc. Interpolating the raw values spins a figure all
    // the way round whenever the simulation's yaw crosses the wrap at +/-pi, which a
    // bulwark turning slowly through a half circle reaches on purpose.
    hunter.root.rotation.y += shortestAngle(entity.rotationY - hunter.root.rotation.y) * (1 - Math.exp(-18 * deltaSeconds));
    hunter.root.rotation.z = THREE.MathUtils.damp(hunter.root.rotation.z, 0, 18, deltaSeconds);
    hunter.root.scale.setScalar(hunter.baseScale);

    this.updateHealthDisplay(hunter, entity, tick, deltaSeconds);

    const horizontalSpeed = Math.hypot(entity.velocity[0], entity.velocity[2]);
    const move = THREE.MathUtils.clamp(horizontalSpeed / 5.5, 0, 1);
    if (hunter.external) {
      // On twos. The clip advances in whole twelfths of a second and the remainder is
      // carried, so a hostile *poses* like an animated figure while its position, its
      // facing and everything the player aims at stay continuous. See
      // `animationStepping` for why the split falls exactly there.
      hunter.poseDebt += deltaSeconds;
      const stepped = this.stepping ? stepAdvance(hunter.poseDebt) : { advance: hunter.poseDebt, pending: 0 };
      hunter.poseDebt = stepped.pending;
      hunter.mixer?.update(stepped.advance);
      if (!hunter.wasGrounded && entity.grounded) hunter.landUntilTick = tick + LAND_TICKS;
      hunter.wasGrounded = entity.grounded;
      const clip = this.resolveMovementClip(hunter, entity, tick, move);
      this.playClip(hunter, clip, 0.12, clip !== 'hunter_land');
      if (hunter.head) hunter.head.rotation.x = THREE.MathUtils.damp(hunter.head.rotation.x, entity.aimPitch * 0.55, 12, deltaSeconds);
      return;
    }
    const frequency = hunter.profile === 'aggressive' ? 10.2 : 8.2;
    // The diagnostic fallback figure steps on the same grid, off a quantised clock
    // rather than a quantised delta -- its pose is a function of absolute time.
    const posed = this.stepping ? steppedTime(time) : time;
    const phase = posed * frequency + entity.id * 0.73;
    const stride = Math.sin(phase) * 0.78 * move;
    const settle = Math.sin(posed * 2.1 + entity.id) * 0.012;
    hunter.leftLeg.rotation.x = THREE.MathUtils.damp(hunter.leftLeg.rotation.x, stride, 18, deltaSeconds);
    hunter.rightLeg.rotation.x = THREE.MathUtils.damp(hunter.rightLeg.rotation.x, -stride, 18, deltaSeconds);
    hunter.leftArm.rotation.x = THREE.MathUtils.damp(hunter.leftArm.rotation.x, -stride * 0.55 - 0.55, 16, deltaSeconds);
    hunter.rightArm.rotation.x = THREE.MathUtils.damp(hunter.rightArm.rotation.x, stride * 0.55 - 0.72, 16, deltaSeconds);
    hunter.chest.position.y = settle + (entity.grounded ? Math.abs(Math.sin(phase)) * 0.04 * move : 0.06);
    hunter.chest.rotation.z = Math.sin(phase) * 0.028 * move;
    hunter.head.rotation.x = THREE.MathUtils.damp(hunter.head.rotation.x, entity.aimPitch * 0.72, 14, deltaSeconds);
    hunter.coat.rotation.z = THREE.MathUtils.damp(hunter.coat.rotation.z, -stride * 0.07, 11, deltaSeconds);
  }

  private playClip(hunter: HunterInstance, name: string, fadeSeconds: number, loop: boolean, force = false): void {
    if (!force && hunter.currentClip === name) return;
    const next = hunter.actions.get(name);
    if (!next) return;
    const previous = hunter.currentClip ? hunter.actions.get(hunter.currentClip) : undefined;
    next.reset();
    next.enabled = true;
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    if (previous && previous !== next && fadeSeconds > 0) previous.crossFadeTo(next, fadeSeconds, false);
    next.play();
    hunter.currentClip = name;
  }

  private resolveMovementClip(hunter: HunterInstance, entity: EntitySnapshot, tick: number, move: number): string {
    if (hunter.hitUntilTick > tick) return 'hunter_hit';
    if (hunter.attackUntilTick > tick) return this.attackClip(hunter);
    if (hunter.landUntilTick > tick) return 'hunter_land';
    if (!entity.grounded) return entity.velocity[1] < -0.35 ? 'hunter_drop' : 'hunter_jump';
    if (move <= 0.12) return 'hunter_idle';

    const rightX = Math.cos(entity.rotationY);
    const rightZ = -Math.sin(entity.rotationY);
    const lateral = entity.velocity[0] * rightX + entity.velocity[2] * rightZ;
    const forwardX = Math.sin(entity.rotationY);
    const forwardZ = Math.cos(entity.rotationY);
    const forward = entity.velocity[0] * forwardX + entity.velocity[2] * forwardZ;
    if (Math.abs(lateral) > Math.max(0.75, Math.abs(forward) * 1.15)) {
      return lateral < 0 ? 'hunter_strafe_l' : 'hunter_strafe_r';
    }
    return 'hunter_run';
  }

  private attackClip(hunter: HunterInstance): string {
    return hunter.profile === 'aggressive' ? 'hunter_melee' : 'hunter_fire';
  }

  /** Lifts each enemy off the background with an emissive rim in its profile colour. */
  /**
   * Accents the hostile's signal trim, not the whole model.
   *
   * This used to make every material on the figure emissive, which is why a hunter read
   * as a uniform glowing blob rather than a silhouette with a readable marking -- and,
   * once the palette moved onto fully saturated cyan and red, two self-illuminated
   * hunters were bright enough to bloom the entire frame white. Dark armour with a
   * glowing stripe is both the look this is drawn from and far easier to read.
   */
  private applyProfileAccent(hunter: HunterInstance): void {
    const accent = new THREE.Color(profileAccent(hunter.profile));
    for (const material of hunter.deathMaterials) {
      if (!('emissive' in material)) continue;
      const standard = material as THREE.MeshStandardMaterial | THREE.MeshToonMaterial;
      if (!ACCENT_MATERIAL.test(standard.name)) {
        standard.emissive.setRGB(0, 0, 0);
        continue;
      }
      standard.emissive.copy(accent);
      standard.emissiveIntensity = ACCENT_EMISSIVE_INTENSITY;
    }
  }

  private createGroundMarker(profile: HostileProfile): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material } {
    const geometry = new THREE.RingGeometry(0.44, 0.6, 28);
    const material = new THREE.MeshBasicMaterial({
      color: profileAccent(profile), transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.02;
    mesh.userData.characterHealth = true;
    return { mesh, geometry, material };
  }

  /**
   * A slab across the bot's front, carried on the model's forward axis so the arc the
   * simulation protects is the arc the player can see.
   *
   * Dark plate, glowing edge and one bright band, rather than a slab of accent: a
   * fully emissive plate reads as a yellow billboard with legs, which is the same
   * mistake that once made a hunter a glowing blob instead of a silhouette.
   */
  private createShieldPlate(profile: HostileProfile): { mesh: THREE.Mesh; geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } {
    const accent = profileAccent(profile);
    const geometry = new THREE.BoxGeometry(SHIELD_PLATE.width * 2, SHIELD_PLATE.height, 0.07);
    // Named to match the accent pass, and deliberately *not* flagged as a readout:
    // unlike the health bar the plate is part of the figure, so it falls and fades
    // with the body instead of hanging in the air after a kill.
    const face = this.materials.build('character', {
      name: 'signal-shield-plate', color: '#1c2530', emissive: accent, emissiveIntensity: 0.16,
    });
    const mesh = new THREE.Mesh(geometry, face);
    mesh.position.set(0, 0.95, SHIELD_PLATE.offset);
    mesh.castShadow = true;

    const rimGeometry = new THREE.BoxGeometry(SHIELD_PLATE.width * 2 + 0.1, SHIELD_PLATE.height + 0.1, 0.035);
    const rim = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.9 });
    const rimMesh = new THREE.Mesh(rimGeometry, rim);
    rimMesh.position.z = -0.03;
    mesh.add(rimMesh);

    const bandGeometry = new THREE.BoxGeometry(SHIELD_PLATE.width * 1.7, 0.09, 0.02);
    const bandMesh = new THREE.Mesh(bandGeometry, rim);
    bandMesh.position.set(0, SHIELD_PLATE.height * 0.2, 0.046);
    mesh.add(bandMesh);
    return { mesh, geometries: [geometry, rimGeometry, bandGeometry], materials: [face, rim] };
  }

  private isolateDeathMaterials(hunter: HunterInstance): void {
    if (hunter.deathMaterials.length > 0) return;
    const clones = new Map<THREE.Material, THREE.Material>();
    hunter.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.userData.characterHealth) return;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const isolated = source.map((material) => {
        const existing = clones.get(material);
        if (existing) return existing;
        // Rebound, because a cloned toon material loses the shading edits that make a
        // hostile legible against a world of flat masses. See `rebindGraphicShading`.
        const created: THREE.Material = rebindGraphicShading(material.clone());
        clones.set(material, created);
        hunter.deathMaterials.push(created);
        return created;
      });
      object.material = Array.isArray(object.material) ? isolated : isolated[0]!;
    });
  }

  private disposeInstance(hunter: HunterInstance): void {
    this.root.remove(hunter.root);
    if (hunter.mixer) {
      hunter.mixer.stopAllAction();
      hunter.mixer.uncacheRoot(hunter.root);
      hunter.mixer = null;
    }
    hunter.actions.clear();
    new Set(hunter.deathMaterials).forEach((material) => material.dispose());
    new Set(hunter.ownedMaterials).forEach((material) => material.dispose());
    new Set(hunter.ownedGeometries).forEach((geometry) => geometry.dispose());
    hunter.deathMaterials.length = 0;
    hunter.ownedMaterials.length = 0;
    hunter.ownedGeometries.length = 0;
  }

  private createTemplate(profile: AuthoredBuild): THREE.Group {
    const root = new THREE.Group();
    root.name = `${profile}-hunter-template`;
    const armor = profile === 'aggressive' ? this.materials.get('armor-red') : this.materials.get('armor');
    const secondary = profile === 'aggressive' ? this.materials.variant('armor', '#3c1726') : this.materials.variant('armor', '#183c4c');
    this.ownedMaterials.push(secondary);
    const visor = profile === 'aggressive' ? this.materials.get('red-light') : this.materials.get('cyan-light');
    const fabric = this.materials.get('fabric');
    const gunmetal = this.materials.get('gunmetal');

    const hips = new THREE.Group();
    hips.position.y = 0.88;
    root.add(hips);
    const pelvis = this.rounded(0.5, 0.3, 0.3, 0.09, fabric);
    pelvis.castShadow = true;
    hips.add(pelvis);
    for (const side of [-1, 1]) {
      const hipPlate = this.rounded(0.18, 0.33, 0.08, 0.045, armor);
      hipPlate.position.set(side * 0.28, -0.05, -0.02);
      hipPlate.rotation.z = side * 0.18;
      hips.add(hipPlate);
    }

    const chestRig = new THREE.Group();
    chestRig.name = 'chest-rig';
    chestRig.position.y = 1.36;
    root.add(chestRig);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.31, 0.42, 8, 14), fabric);
    torso.scale.set(1.04, 1, 0.64);
    torso.castShadow = true;
    chestRig.add(torso);
    const chestPlate = this.rounded(profile === 'aggressive' ? 0.78 : 0.68, 0.47, 0.19, 0.095, armor);
    chestPlate.position.set(0, 0.04, -0.27);
    chestPlate.rotation.x = -0.05;
    chestPlate.castShadow = true;
    chestRig.add(chestPlate);
    const sternum = this.rounded(0.15, 0.37, 0.08, 0.03, visor);
    sternum.position.set(0, 0.03, -0.385);
    chestRig.add(sternum);
    for (const side of [-1, 1]) {
      const collar = this.rounded(0.27, 0.12, 0.27, 0.05, secondary);
      collar.position.set(side * 0.25, 0.25, -0.09);
      collar.rotation.z = side * 0.18;
      chestRig.add(collar);
      const rib = this.rounded(0.12, 0.25, 0.08, 0.025, gunmetal);
      rib.position.set(side * 0.29, -0.13, -0.31);
      rib.rotation.z = side * 0.13;
      chestRig.add(rib);
    }

    const coatRig = new THREE.Group();
    coatRig.name = 'coat-rig';
    coatRig.position.set(0, 1.06, 0.12);
    root.add(coatRig);
    for (const side of [-1, 1]) {
      const coat = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.54, profile === 'aggressive' ? 0.58 : 0.82, 12, 1, true, side < 0 ? 0 : Math.PI, Math.PI), secondary);
      coat.position.set(side * 0.05, -0.18, 0.04);
      coat.rotation.y = side * 0.08;
      coat.castShadow = true;
      coatRig.add(coat);
    }

    const headRig = new THREE.Group();
    headRig.name = 'head-rig';
    headRig.position.y = 2.02;
    root.add(headRig);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.13, 0.18, 10), gunmetal);
    neck.position.y = -0.25;
    headRig.add(neck);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.285, 18, 12), armor);
    helmet.scale.set(0.91, 1.08, 0.95);
    helmet.castShadow = true;
    headRig.add(helmet);
    const faceplate = this.rounded(0.43, 0.21, 0.11, 0.065, gunmetal);
    faceplate.position.set(0, -0.015, -0.245);
    headRig.add(faceplate);
    const visorStrip = this.rounded(profile === 'aggressive' ? 0.36 : 0.3, 0.055, 0.035, 0.017, visor);
    visorStrip.position.set(0, 0.025, -0.315);
    headRig.add(visorStrip);
    if (profile === 'ranged') {
      const optic = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.17, 14), this.materials.get('glass'));
      optic.rotation.x = Math.PI / 2;
      optic.position.set(0.19, 0.07, -0.3);
      headRig.add(optic);
    } else {
      for (const side of [-1, 1]) {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.27, 7), armor);
        horn.position.set(side * 0.19, 0.3, 0.03);
        horn.rotation.z = side * -0.42;
        headRig.add(horn);
      }
    }

    const leftLeg = this.createLimb('left-leg', -0.19, 0.86, armor, fabric, false);
    const rightLeg = this.createLimb('right-leg', 0.19, 0.86, armor, fabric, false);
    const leftArm = this.createLimb('left-arm', -0.45, 1.62, armor, fabric, true);
    const rightArm = this.createLimb('right-arm', 0.45, 1.62, armor, fabric, true);
    leftArm.rotation.z = -0.1;
    rightArm.rotation.z = 0.1;
    root.add(leftLeg, rightLeg, leftArm, rightArm);

    if (profile === 'ranged') root.add(this.createMarksmanRifle());
    else root.add(this.createPressureBlade());
    this.addSelectiveOutline(chestPlate, 1.045);
    this.addSelectiveOutline(helmet, 1.035);
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = object.castShadow || object.position.y > 0;
        object.receiveShadow = true;
      }
    });
    return root;
  }

  private createLimb(name: string, x: number, y: number, armor: THREE.Material, fabric: THREE.Material, arm: boolean): THREE.Group {
    const pivot = new THREE.Group();
    pivot.name = name;
    pivot.position.set(x, y, 0);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(arm ? 0.095 : 0.12, arm ? 0.36 : 0.46, 7, 10), fabric);
    upper.position.y = arm ? -0.25 : -0.34;
    pivot.add(upper);
    const joint = new THREE.Mesh(new THREE.SphereGeometry(arm ? 0.11 : 0.13, 12, 8), this.materials.get('gunmetal'));
    joint.position.y = arm ? -0.47 : -0.62;
    pivot.add(joint);
    const lower = new THREE.Mesh(new THREE.CapsuleGeometry(arm ? 0.085 : 0.105, arm ? 0.34 : 0.43, 7, 10), fabric);
    lower.position.y = arm ? -0.68 : -0.88;
    pivot.add(lower);
    const plate = this.rounded(arm ? 0.22 : 0.25, arm ? 0.36 : 0.43, 0.14, 0.055, armor);
    plate.position.set(0, arm ? -0.23 : -0.79, -0.1);
    pivot.add(plate);
    const end = this.rounded(arm ? 0.17 : 0.25, arm ? 0.14 : 0.16, arm ? 0.22 : 0.38, 0.05, this.materials.get('gunmetal'));
    end.position.set(0, arm ? -0.92 : -1.17, arm ? -0.06 : -0.08);
    pivot.add(end);
    return pivot;
  }

  private createMarksmanRifle(): THREE.Group {
    const weapon = new THREE.Group();
    weapon.position.set(0.43, 1.21, -0.4);
    weapon.rotation.set(-0.12, 0, -0.08);
    const body = this.rounded(0.16, 0.18, 1.12, 0.045, this.materials.get('gunmetal'));
    const rail = this.rounded(0.2, 0.035, 0.82, 0.01, this.materials.get('cyan-light'));
    rail.position.y = 0.11;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.038, 0.65, 12), this.materials.get('gunmetal'));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.78;
    const optic = this.rounded(0.19, 0.17, 0.32, 0.05, this.materials.get('glass'));
    optic.position.set(0, 0.18, -0.05);
    weapon.add(body, rail, barrel, optic);
    return weapon;
  }

  private createPressureBlade(): THREE.Group {
    const weapon = new THREE.Group();
    weapon.position.set(0.48, 1.05, -0.15);
    weapon.rotation.z = -0.14;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.52, 10), this.materials.get('gunmetal'));
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.095, 1.15, 5), this.materials.get('red-light'));
    blade.position.y = -0.8;
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.035, 7, 18), this.materials.get('armor-red'));
    guard.rotation.x = Math.PI / 2;
    guard.position.y = -0.28;
    weapon.add(handle, blade, guard);
    return weapon;
  }

  /**
   * A wide, framed bar with a trailing chip layer. The fill is coloured by
   * remaining health rather than by archetype, so a wounded enemy reads at a
   * glance, and it is yaw-billboarded and distance-compensated in
   * `updateHealthDisplay` so it stays legible across an arena.
   */
  private createHealthDisplay(profile: HostileProfile): HealthDisplay {
    const group = new THREE.Group();
    group.position.set(0, 2.32, 0);
    const frameMaterial = new THREE.MeshBasicMaterial({ color: '#04070c', transparent: true, opacity: 0.92, depthTest: false });
    const trackMaterial = new THREE.MeshBasicMaterial({ color: '#1b2732', transparent: true, opacity: 0.9, depthTest: false });
    const chipMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthTest: false });
    const fillMaterial = new THREE.MeshBasicMaterial({ color: HEALTH_HIGH, transparent: true, opacity: 1, depthTest: false });

    const frameGeometry = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH + 0.07, HEALTH_BAR_HEIGHT + 0.06);
    const trackGeometry = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
    const barGeometry = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
    // Anchor the scalable layers to their left edge so they drain rightward.
    barGeometry.translate(HEALTH_BAR_WIDTH / 2, 0, 0);

    const frame = new THREE.Mesh(frameGeometry, frameMaterial);
    const track = new THREE.Mesh(trackGeometry, trackMaterial);
    const chip = new THREE.Mesh(barGeometry, chipMaterial);
    const fill = new THREE.Mesh(barGeometry, fillMaterial);
    fill.name = 'health-fill';
    frame.position.z = -0.012;
    track.position.z = -0.008;
    chip.position.set(-HEALTH_BAR_WIDTH / 2, 0, -0.004);
    fill.position.set(-HEALTH_BAR_WIDTH / 2, 0, 0);
    for (const mesh of [frame, track, chip, fill]) {
      mesh.userData.characterHealth = true;
      mesh.renderOrder = 12;
    }
    // A colour pip keeps the archetype readable now the fill tracks health.
    const pipMaterial = new THREE.MeshBasicMaterial({ color: profileAccent(profile), transparent: true, depthTest: false });
    const pipGeometry = new THREE.PlaneGeometry(0.09, HEALTH_BAR_HEIGHT + 0.06);
    const pip = new THREE.Mesh(pipGeometry, pipMaterial);
    pip.position.set(-HEALTH_BAR_WIDTH / 2 - 0.09, 0, -0.002);
    pip.userData.characterHealth = true;
    pip.renderOrder = 12;

    group.add(frame, track, chip, fill, pip);
    return {
      group,
      fill,
      chip,
      fillMaterial,
      geometries: [frameGeometry, trackGeometry, barGeometry, pipGeometry],
      materials: [frameMaterial, trackMaterial, chipMaterial, fillMaterial, pipMaterial],
    };
  }

  private updateHealthDisplay(hunter: HunterInstance, entity: EntitySnapshot, tick: number, deltaSeconds: number): void {
    // Published by the simulation rather than re-derived here: a daily modifier
    // scales bot health, so an authored profile is not what the bar is measured on.
    const fraction = THREE.MathUtils.clamp(entity.health / Math.max(1, entity.maxHealth), 0, 1);
    hunter.healthFraction = fraction;
    // The chip layer lags behind so the size of each bite of damage is visible.
    hunter.chipFraction = hunter.chipFraction < fraction
      ? fraction
      : Math.max(fraction, hunter.chipFraction - CHIP_DRAIN_PER_SECOND * deltaSeconds);
    hunter.healthFill.scale.x = Math.max(0.001, fraction);
    hunter.healthChip.scale.x = Math.max(0.001, hunter.chipFraction);

    const flashing = hunter.hitUntilTick > tick;
    hunter.healthFillMaterial.color.set(flashing
      ? '#ffffff'
      : fraction > 0.6 ? HEALTH_HIGH : fraction > 0.3 ? HEALTH_MID : HEALTH_LOW);

    // Yaw-billboard toward the camera and grow with distance so the bar holds a
    // roughly constant on-screen size instead of vanishing across an arena.
    const camera = this.cameraPosition;
    const dx = camera.x - entity.position[0];
    const dz = camera.z - entity.position[2];
    hunter.healthRoot.rotation.y = Math.atan2(dx, dz) - hunter.root.rotation.y;
    const distance = Math.hypot(dx, camera.y - entity.position[1], dz);
    hunter.healthRoot.scale.setScalar(THREE.MathUtils.clamp(distance / HEALTH_REFERENCE_DISTANCE, 1, HEALTH_MAX_SCALE));
  }

  private addSelectiveOutline(mesh: THREE.Mesh, scale: number): void {
    const material = new THREE.MeshBasicMaterial({ color: '#05070d', side: THREE.BackSide });
    this.ownedMaterials.push(material);
    const outline = new THREE.Mesh(mesh.geometry, material);
    outline.scale.setScalar(scale);
    outline.userData.characterOutline = true;
    mesh.add(outline);
  }

  private rounded(x: number, y: number, z: number, radius: number, material: THREE.Material): THREE.Mesh {
    return new THREE.Mesh(new RoundedBoxGeometry(x, y, z, 2, Math.min(radius, x / 3, y / 3, z / 3)), material);
  }
}
