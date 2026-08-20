import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { GameEvent, SaveDataV1, SimulationSnapshot, WeaponChassisId, WeaponPartSlot } from '../../contracts';
import { weaponPartSlots } from '../../content/weapons';
import { MaterialLibrary } from './MaterialLibrary';

interface ExtendedPlayerPresentation {
  adsProgress?: number;
  actionProgress?: number;
}

/** Per-chassis proportions applied on top of the shared carbine geometry. */
const CHASSIS_SHAPE: Record<WeaponChassisId, { width: number; length: number; barrel: number; bore: number; stock: boolean }> = {
  carbine: { width: 1, length: 1, barrel: 1, bore: 1, stock: true },
  smg: { width: 0.96, length: 0.9, barrel: 0.66, bore: 0.92, stock: false },
  shotgun: { width: 1.07, length: 0.97, barrel: 0.9, bore: 1.32, stock: true },
  dmr: { width: 0.97, length: 1.06, barrel: 1.38, bore: 1.04, stock: true },
};

export class ViewmodelPresenter {
  readonly root = new THREE.Group();
  readonly muzzleSocket = new THREE.Object3D();
  readonly grappleSocket = new THREE.Object3D();
  private readonly rifle = new THREE.Group();
  private readonly leftArm = new THREE.Group();
  private readonly rightArm = new THREE.Group();
  private readonly magazine = new THREE.Group();
  private readonly opticGroup = new THREE.Group();
  private readonly barrelGroup = new THREE.Group();
  private readonly stockGroup = new THREE.Group();
  private readonly gripGroup = new THREE.Group();
  private readonly foreGrip = new THREE.Group();
  private appliedVisualKey = '';
  private readonly bolt = new THREE.Group();
  private readonly muzzleFlash = new THREE.Group();
  private readonly muzzleLight = new THREE.PointLight('#ffb75f', 0, 3.5, 2);
  private readonly generatedMaterials: THREE.Material[] = [];
  private readonly generatedTextures: THREE.Texture[] = [];
  private externalModel: THREE.Object3D | null = null;
  private externalGrappleSocket: THREE.Object3D | null = null;
  private externalMixer: THREE.AnimationMixer | null = null;
  private readonly externalActions = new Map<string, THREE.AnimationAction>();
  private externalClip: string | null = null;
  private externalTransientClip: string | null = null;
  private externalTransientSeconds = 0;
  private fireVariant = 0;
  private adsWasActive = false;
  private recoil = 0;
  private lateralRecoil = 0;
  private muzzleEnergy = 0;
  private grappleKick = 0;
  private settings: SaveDataV1['settings'];

  constructor(private readonly materials: MaterialLibrary, settings: SaveDataV1['settings']) {
    this.settings = settings;
    this.root.name = 'VX-09 Viewmodel';
    this.buildArms();
    this.buildCarbine();
    this.buildMuzzleFlash();
    this.root.add(this.leftArm, this.rightArm, this.rifle);
    this.root.position.set(0.1, -0.17, -0.3);
  }

  updateSettings(settings: SaveDataV1['settings']): void {
    this.settings = settings;
  }

  /**
   * Reshapes the procedural weapon to match the equipped build. Chassis sets the
   * overall proportions and each fitted part scales or hides the group it owns,
   * so what the player assembled is what they see in hand.
   */
  applyBuild(chassisId: WeaponChassisId, parts: Partial<Record<WeaponPartSlot, string>>): void {
    const key = `${chassisId}|${weaponPartSlots.map((slot) => parts[slot] ?? '').join('|')}`;
    if (key === this.appliedVisualKey) return;
    this.appliedVisualKey = key;

    const chassis = CHASSIS_SHAPE[chassisId];
    // Keep the chassis deltas modest: the arms are posed for this body, so large
    // rescaling pulls the weapon away from the hands.
    this.rifle.scale.set(chassis.width, chassis.width, chassis.length);
    this.barrelGroup.scale.set(chassis.bore, chassis.bore, chassis.barrel);
    this.stockGroup.visible = chassis.stock;

    const optic = parts.optic ?? 'optic.irons';
    this.opticGroup.visible = optic !== 'optic.irons';
    // A scope is a longer, taller tube; a reflex sits low and compact.
    const scoped = optic === 'optic.scope';
    this.opticGroup.scale.set(scoped ? 1.15 : 0.8, scoped ? 1.1 : 0.72, scoped ? 1.55 : 0.85);
    this.opticGroup.position.y = scoped ? 0.03 : -0.02;

    const barrel = parts.barrel ?? 'barrel.standard';
    const barrelScale = barrel === 'barrel.short' ? 0.66 : barrel === 'barrel.long' ? 1.34 : 1;
    this.barrelGroup.scale.z *= barrelScale;
    // A choke fattens the muzzle end rather than lengthening it.
    if (barrel === 'barrel.choke') this.barrelGroup.scale.set(chassis.bore * 1.35, chassis.bore * 1.35, chassis.barrel);

    const magazine = parts.magazine ?? 'magazine.standard';
    this.magazine.scale.set(
      magazine === 'magazine.drum' ? 1.5 : 1,
      magazine === 'magazine.extended' ? 1.45 : magazine === 'magazine.drum' ? 1.6 : magazine === 'magazine.quickfeed' ? 0.78 : 1,
      magazine === 'magazine.drum' ? 1.5 : 1,
    );

    this.foreGrip.visible = (parts.grip ?? 'grip.standard') === 'grip.vertical';
    this.gripGroup.rotation.x = (parts.grip ?? 'grip.standard') === 'grip.angled' ? -0.34 : 0;

    const stock = parts.stock ?? 'stock.standard';
    this.stockGroup.scale.set(stock === 'stock.heavy' ? 1.25 : stock === 'stock.light' ? 0.8 : 1, stock === 'stock.heavy' ? 1.2 : 0.9, 1);
  }

  /**
   * Hides the arms so the weapon can be shown on its own. The gun builder renders
   * the same presenter the run does, which is the point: what is on the bench is
   * literally the model that ends up in the player's hands.
   */
  setHandsVisible(visible: boolean): void {
    this.leftArm.visible = visible;
    this.rightArm.visible = visible;
  }

  setExternalModel(model: THREE.Object3D | null, animations: readonly THREE.AnimationClip[] = []): void {
    if (this.externalModel === model) return;
    this.externalMixer?.stopAllAction();
    if (this.externalMixer && this.externalModel) this.externalMixer.uncacheRoot(this.externalModel);
    this.externalMixer = null;
    this.externalActions.clear();
    this.externalClip = null;
    this.externalTransientClip = null;
    this.externalTransientSeconds = 0;
    this.adsWasActive = false;
    this.rifle.add(this.muzzleFlash, this.muzzleLight);
    this.muzzleFlash.position.copy(this.muzzleSocket.position);
    this.muzzleLight.position.copy(this.muzzleSocket.position);
    this.externalModel?.removeFromParent();
    this.externalModel = model;
    this.externalGrappleSocket = null;
    const proceduralVisible = model === null;
    this.rifle.visible = proceduralVisible;
    this.leftArm.visible = proceduralVisible;
    this.rightArm.visible = proceduralVisible;
    if (model) {
      model.position.set(0.24, -0.28, -0.82);
      // The exported source already faces the view camera's -Z axis.
      model.rotation.set(0, 0, 0);
      model.traverse((object) => {
        if (object instanceof THREE.Mesh) object.castShadow = true;
      });
      this.externalMixer = new THREE.AnimationMixer(model);
      for (const clip of animations) this.externalActions.set(clip.name, this.externalMixer.clipAction(clip));
      this.queueExternalTransient('vm_equip', 0.42);
      this.playExternalClip('vm_equip', 0, false);
      const externalMuzzle = model.getObjectByName('socket_muzzle');
      if (externalMuzzle) {
        externalMuzzle.add(this.muzzleFlash, this.muzzleLight);
        this.muzzleFlash.position.set(0, 0, 0);
        this.muzzleLight.position.set(0, 0, 0);
      }
      this.externalGrappleSocket = model.getObjectByName('socket_grapple_emitter') ?? null;
      this.root.add(model);
    }
  }

  /** Camera-local emitter position used to anchor the world-space cable pass. */
  grappleEmitterOffset(target: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return (this.externalGrappleSocket ?? this.grappleSocket).getWorldPosition(target);
  }

  consume(events: readonly GameEvent[]): void {
    for (const event of events) {
      if (event.kind === 'shot') {
        this.recoil = Math.min(1, this.recoil + 0.72);
        this.lateralRecoil = ((event.id * 16807) % 1000 / 1000 - 0.5) * 0.016;
        this.muzzleEnergy = 1;
        this.fireVariant = 1 - this.fireVariant;
        this.queueExternalTransient(this.fireVariant === 0 ? 'vm_fire_01' : 'vm_fire_02', 0.12);
      } else if (event.kind === 'grappleAttach') {
        this.grappleKick = 1;
        this.queueExternalTransient('vm_grapple_cast', 0.16);
      } else if (event.kind === 'grappleRelease') {
        this.queueExternalTransient('vm_grapple_release', 0.18);
      }
    }
  }

  update(snapshot: SimulationSnapshot, time: number, deltaSeconds: number): void {
    const presentation = snapshot.player as SimulationSnapshot['player'] & ExtendedPlayerPresentation;
    const ads = THREE.MathUtils.clamp(presentation.adsProgress ?? 0, 0, 1);
    const speed = THREE.MathUtils.clamp(snapshot.player.speed / 13, 0, 1);
    const groundedMovement = snapshot.player.locomotion === 'grounded' || snapshot.player.locomotion === 'sliding';
    const reducedMotion = this.settings.reducedMotion;
    const bobScale = reducedMotion ? 0 : this.settings.headBob * speed * (groundedMovement ? 1 : 0.18);
    const bobX = Math.cos(time * (7.5 + speed * 4.5)) * 0.012 * bobScale;
    const bobY = Math.abs(Math.sin(time * (7.5 + speed * 4.5))) * 0.014 * bobScale;
    const sprint = snapshot.player.locomotion === 'dashing' ? 1 : speed > 0.72 && ads < 0.1 ? speed : 0;

    const adsActive = ads > 0.08;
    if (this.adsWasActive && !adsActive) this.queueExternalTransient('vm_ads_out', 0.15);
    this.adsWasActive = adsActive;
    this.externalTransientSeconds = Math.max(0, this.externalTransientSeconds - deltaSeconds);
    if (this.externalTransientSeconds <= 0) this.externalTransientClip = null;

    // Deterministic visual-regression frames use a zero delta and must not land
    // on a load-timing-dependent one-shot pose.
    if (deltaSeconds === 0) this.playExternalClip('vm_idle', 0, true);
    else if (this.externalTransientClip) this.playExternalClip(this.externalTransientClip, 0.06, false);
    else if (snapshot.player.action === 'reloading') {
      this.playExternalClip(snapshot.player.ammo === 0 ? 'vm_reload_empty' : 'vm_reload_tactical', 0.1, false);
    } else if (snapshot.player.action === 'melee') this.playExternalClip('vm_melee', 0.08, false);
    else if (snapshot.player.grapple.active) this.playExternalClip('vm_grapple_hold', 0.1, true);
    else if (snapshot.player.action === 'firing') this.playExternalClip(this.fireVariant === 0 ? 'vm_fire_01' : 'vm_fire_02', 0.06, false);
    else if (sprint > 0.35) this.playExternalClip('vm_sprint', 0.12, true);
    else if (adsActive) this.playExternalClip('vm_ads_in', 0.1, false);
    else this.playExternalClip('vm_idle', 0.12, true);
    this.externalMixer?.update(deltaSeconds);

    this.recoil = THREE.MathUtils.damp(this.recoil, 0, 16, deltaSeconds);
    this.lateralRecoil = THREE.MathUtils.damp(this.lateralRecoil, 0, 20, deltaSeconds);
    this.grappleKick = THREE.MathUtils.damp(this.grappleKick, 0, 12, deltaSeconds);
    this.muzzleEnergy = THREE.MathUtils.damp(this.muzzleEnergy, 0, 28, deltaSeconds);

    const targetX = THREE.MathUtils.lerp(0.1, -0.168, ads) + bobX + this.lateralRecoil;
    const targetY = THREE.MathUtils.lerp(-0.17, -0.035, ads) - bobY - sprint * 0.08;
    const targetZ = THREE.MathUtils.lerp(-0.3, -0.12, ads) + this.recoil * 0.055;
    this.root.position.x = THREE.MathUtils.damp(this.root.position.x, targetX, 18, deltaSeconds);
    this.root.position.y = THREE.MathUtils.damp(this.root.position.y, targetY, 18, deltaSeconds);
    this.root.position.z = THREE.MathUtils.damp(this.root.position.z, targetZ, 22, deltaSeconds);
    this.root.rotation.x = THREE.MathUtils.damp(this.root.rotation.x, -this.recoil * 0.085 + this.grappleKick * 0.028, 24, deltaSeconds);
    this.root.rotation.y = THREE.MathUtils.damp(this.root.rotation.y, this.lateralRecoil * 1.8, 22, deltaSeconds);
    this.root.rotation.z = THREE.MathUtils.damp(this.root.rotation.z, -sprint * 0.28 + (snapshot.player.locomotion === 'sliding' ? -0.08 : 0), 12, deltaSeconds);

    const reload = snapshot.player.action === 'reloading';
    const reloadProgress = reload ? (presentation.actionProgress ?? ((time * 1.05) % 1)) : 0;
    const reloadArc = reload ? Math.sin(reloadProgress * Math.PI) : 0;
    this.magazine.position.y = -reloadArc * 0.55;
    this.magazine.rotation.z = reloadArc * 0.42;
    this.leftArm.rotation.x = THREE.MathUtils.damp(this.leftArm.rotation.x, reload ? -0.6 - reloadArc * 0.65 : 0, 14, deltaSeconds);
    this.leftArm.rotation.z = THREE.MathUtils.damp(this.leftArm.rotation.z, reload ? 0.25 : 0, 14, deltaSeconds);
    this.bolt.position.z = -0.02 + this.recoil * 0.085;

    const flashScale = 0.72 + this.muzzleEnergy * 0.8;
    this.muzzleFlash.visible = this.muzzleEnergy > 0.04 && !this.settings.reducedMotion;
    this.muzzleFlash.scale.setScalar(flashScale / Math.max(0.001, this.externalModel?.scale.x ?? 1));
    this.muzzleFlash.rotation.z = time * 23;
    this.muzzleLight.intensity = this.settings.reducedMotion ? 0 : this.muzzleEnergy * 8;
  }

  dispose(): void {
    this.externalMixer?.stopAllAction();
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    this.generatedMaterials.forEach((material) => material.dispose());
    this.generatedTextures.forEach((texture) => texture.dispose());
  }

  private playExternalClip(name: string, fadeSeconds: number, loop: boolean): void {
    if (this.externalClip === name) return;
    const next = this.externalActions.get(name);
    if (!next) return;
    const previous = this.externalClip ? this.externalActions.get(this.externalClip) : undefined;
    next.reset();
    next.enabled = true;
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    if (previous && fadeSeconds > 0) previous.crossFadeTo(next, fadeSeconds, false);
    next.play();
    this.externalClip = name;
  }

  private queueExternalTransient(name: string, durationSeconds: number): void {
    if (!this.externalActions.has(name)) return;
    this.externalTransientClip = name;
    this.externalTransientSeconds = durationSeconds;
  }

  private buildCarbine(): void {
    const ceramic = this.materials.get('ceramic');
    const gunmetal = this.materials.get('gunmetal');
    const carbon = this.materials.get('carbon');
    const accent = this.materials.get('red-light');
    this.rifle.position.set(0.15, -0.19, -1.02);

    const upper = this.extrudedReceiver();
    upper.position.set(-0.11, -0.01, 0.24);
    upper.rotation.y = Math.PI;
    upper.castShadow = true;
    this.rifle.add(upper);

    const lower = this.rounded(0.23, 0.2, 0.57, 0.035, gunmetal);
    lower.position.set(0, -0.095, 0.26);
    this.rifle.add(lower);
    const cheek = this.rounded(0.26, 0.12, 0.42, 0.04, carbon);
    cheek.position.set(0, 0.055, 0.61);
    this.rifle.add(cheek);
    const stockBeam = this.rounded(0.12, 0.1, 0.5, 0.035, gunmetal);
    stockBeam.position.set(0, -0.015, 0.82);
    const stockPad = this.rounded(0.28, 0.38, 0.12, 0.055, carbon);
    stockPad.position.set(0, -0.12, 1.08);
    this.stockGroup.add(stockBeam, stockPad);
    this.rifle.add(this.stockGroup);

    const handguard = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 0.68, 10, 1, false), ceramic);
    handguard.rotation.x = Math.PI / 2;
    handguard.position.set(0, 0, -0.42);
    this.rifle.add(handguard);
    const handguardCore = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.76, 16), carbon);
    handguardCore.rotation.x = Math.PI / 2;
    handguardCore.position.z = -0.42;
    this.rifle.add(handguardCore);
    for (let index = 0; index < 6; index += 1) {
      const slot = this.rounded(0.025, 0.035, 0.24, 0.01, accent);
      const angle = index / 6 * Math.PI * 2;
      slot.position.set(Math.cos(angle) * 0.154, Math.sin(angle) * 0.154, -0.44);
      slot.rotation.z = angle;
      this.rifle.add(slot);
    }

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, 0.78, 16), gunmetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.98;
    this.barrelGroup.add(barrel);
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.19, 10), gunmetal);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.z = -1.42;
    this.barrelGroup.add(muzzle);
    this.rifle.add(this.barrelGroup);
    for (const x of [-0.042, 0.042]) {
      const port = this.rounded(0.018, 0.045, 0.07, 0.006, carbon);
      port.position.set(x, 0, -1.46);
      this.rifle.add(port);
    }

    const rail = this.rounded(0.12, 0.035, 1.12, 0.012, gunmetal);
    rail.position.set(0, 0.185, -0.02);
    this.rifle.add(rail);
    for (let index = 0; index < 11; index += 1) {
      const tooth = this.rounded(0.18, 0.045, 0.034, 0.008, gunmetal);
      tooth.position.set(0, 0.205, 0.42 - index * 0.095);
      this.rifle.add(tooth);
    }

    const opticBase = this.rounded(0.19, 0.075, 0.28, 0.025, gunmetal);
    opticBase.position.set(0, 0.235, 0.2);
    const opticBody = this.rounded(0.25, 0.22, 0.31, 0.06, carbon);
    opticBody.position.set(0, 0.37, 0.15);
    this.opticGroup.add(opticBase, opticBody);
    for (const z of [0.0, 0.3]) {
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.087, 0.087, 0.012, 24), this.materials.get('glass'));
      lens.rotation.x = Math.PI / 2;
      lens.position.set(0, 0.38, z);
      this.opticGroup.add(lens);
    }
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.014, 0.019, 16), this.materials.get('cyan-light'));
    reticle.position.set(0, 0.38, -0.009);
    this.opticGroup.add(reticle);
    this.rifle.add(this.opticGroup);

    this.buildMagazine();
    this.magazine.position.set(0, -0.25, 0.31);
    this.rifle.add(this.magazine);
    const grip = this.rounded(0.14, 0.38, 0.17, 0.04, carbon);
    grip.position.set(0, -0.32, 0.58);
    grip.rotation.x = -0.2;
    this.gripGroup.add(grip);
    this.rifle.add(this.gripGroup);
    const foreGripBody = this.rounded(0.11, 0.3, 0.13, 0.035, carbon);
    foreGripBody.position.set(0, -0.26, -0.4);
    this.foreGrip.add(foreGripBody);
    this.rifle.add(this.foreGrip);
    const triggerGuard = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.018, 7, 18, Math.PI), gunmetal);
    triggerGuard.rotation.x = Math.PI / 2;
    triggerGuard.position.set(0, -0.15, 0.57);
    this.rifle.add(triggerGuard);

    const boltCarrier = this.rounded(0.035, 0.065, 0.28, 0.014, ceramic);
    boltCarrier.position.set(0.122, 0.045, 0.28);
    this.bolt.add(boltCarrier);
    const boltHandle = this.rounded(0.11, 0.035, 0.035, 0.012, gunmetal);
    boltHandle.position.set(0.17, 0.045, 0.38);
    this.bolt.add(boltHandle);
    this.rifle.add(this.bolt);

    const decal = this.createWeaponDecal();
    decal.position.set(0.121, 0.03, 0.23);
    decal.rotation.y = Math.PI / 2;
    this.rifle.add(decal);

    this.muzzleSocket.position.set(0, 0, -1.54);
    this.grappleSocket.position.set(-0.12, 0.06, -0.73);
    this.muzzleLight.position.copy(this.muzzleSocket.position);
    this.muzzleFlash.position.copy(this.muzzleSocket.position);
    this.rifle.add(this.muzzleSocket, this.grappleSocket, this.muzzleFlash, this.muzzleLight);

    this.rifle.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = true;
    });
  }

  private buildMagazine(): void {
    const body = this.rounded(0.18, 0.5, 0.22, 0.045, this.materials.get('gunmetal'));
    body.rotation.x = -0.12;
    this.magazine.add(body);
    const window = this.rounded(0.105, 0.31, 0.018, 0.012, this.materials.get('glass'));
    window.position.set(0, -0.01, -0.117);
    window.rotation.x = -0.12;
    this.magazine.add(window);
    for (let index = 0; index < 5; index += 1) {
      const round = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.055, 3, 6), this.materials.get('amber-light'));
      round.rotation.z = Math.PI / 2;
      round.position.set(-0.035 + (index % 2) * 0.07, 0.1 - index * 0.055, -0.13);
      this.magazine.add(round);
    }
  }

  private buildArms(): void {
    this.leftArm.position.set(-0.24, -0.43, -1.02);
    this.rightArm.position.set(0.33, -0.5, -0.69);
    this.leftArm.rotation.set(0, 0, -0.08);
    this.rightArm.rotation.set(0, 0, 0.08);
    this.leftArm.add(this.createArm(false));
    this.rightArm.add(this.createArm(true));
  }

  private createArm(right: boolean): THREE.Group {
    const group = new THREE.Group();
    const side = right ? 1 : -1;
    const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.47, 8, 12), this.materials.get('fabric'));
    sleeve.rotation.x = Math.PI / 2.65;
    sleeve.position.set(side * 0.02, -0.15, 0.22);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.13, 10), this.materials.get('armor'));
    cuff.rotation.x = Math.PI / 2.65;
    cuff.position.set(side * 0.02, 0.02, -0.02);
    const palm = this.rounded(0.19, 0.105, 0.24, 0.04, this.materials.get('armor'));
    palm.position.set(0, 0.04, -0.16);
    palm.rotation.x = right ? -0.12 : 0.18;
    const palmInset = this.rounded(0.11, 0.03, 0.14, 0.018, this.materials.get('skin'));
    palmInset.position.set(0, -0.065, -0.17);
    group.add(sleeve, cuff, palm, palmInset);
    for (let index = 0; index < 4; index += 1) {
      const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.021, 0.11 + index * 0.008, 5, 7), this.materials.get('armor'));
      finger.rotation.x = Math.PI / 2;
      finger.position.set((-0.064 + index * 0.043) * side, -0.015, -0.31);
      group.add(finger);
    }
    const plate = this.rounded(0.16, 0.035, 0.13, 0.018, right ? this.materials.get('armor-red') : this.materials.get('ceramic'));
    plate.position.set(0, 0.115, -0.15);
    group.add(plate);
    return group;
  }

  private buildMuzzleFlash(): void {
    const flash = this.materials.get('amber-light');
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 1), flash);
    core.scale.z = 2.6;
    this.muzzleFlash.add(core);
    for (let index = 0; index < 5; index += 1) {
      const petal = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.3, 4), flash);
      const angle = index / 5 * Math.PI * 2;
      petal.position.set(Math.cos(angle) * 0.08, Math.sin(angle) * 0.08, -0.08);
      petal.rotation.z = angle;
      petal.rotation.x = Math.PI / 2;
      this.muzzleFlash.add(petal);
    }
    this.muzzleFlash.visible = false;
  }

  private extrudedReceiver(): THREE.Mesh {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.22, 0.01);
    shape.lineTo(0.25, 0.11);
    shape.lineTo(0.2, 0.2);
    shape.lineTo(0.04, 0.22);
    shape.lineTo(-0.02, 0.15);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.62, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.018, bevelThickness: 0.018, curveSegments: 4 });
    geometry.translate(-0.11, -0.11, -0.31);
    return new THREE.Mesh(geometry, this.materials.get('ceramic'));
  }

  private createWeaponDecal(): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ff416d';
    context.fillRect(0, 0, 14, canvas.height);
    context.fillStyle = '#e7f8ff';
    context.font = '800 48px system-ui';
    context.fillText('VX—09', 34, 56);
    context.fillStyle = '#6eeeff';
    context.font = '600 22px system-ui';
    context.fillText('MODULAR BALLISTIC PLATFORM // 5.56', 36, 94);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.generatedTextures.push(texture);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
    this.generatedMaterials.push(material);
    return new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.105), material);
  }

  private rounded(x: number, y: number, z: number, radius: number, material: THREE.Material): THREE.Mesh {
    return new THREE.Mesh(new RoundedBoxGeometry(x, y, z, 3, Math.min(radius, x / 3, y / 3, z / 3)), material);
  }
}
