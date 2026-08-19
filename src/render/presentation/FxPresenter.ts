import * as THREE from 'three';
import type { GameEvent, SaveDataV1 } from '../../contracts';
import { MaterialLibrary } from './MaterialLibrary';

interface TimedObject {
  object: THREE.Object3D;
  bornAt: number;
  expiresAt: number;
  active: boolean;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

const HIT_COLOR = new THREE.Color('#ff315f');
const WALL_IMPACT_COLOR = new THREE.Color('#51f5ff');
const IMPACT_COLOR = new THREE.Color('#ffd08b');
const TRACER_TINT = new THREE.Color('#fff4c7');
/** Incoming fire is its own colour so it never reads as one of the player's own traces. */
const ENEMY_TRACER_COLOR = new THREE.Color('#ff2f4d');

export class FxPresenter {
  readonly root = new THREE.Group();
  private readonly tracers: TimedObject[] = [];
  private readonly impacts: TimedObject[] = [];
  private readonly sparks: TimedObject[] = [];
  private readonly shells: TimedObject[] = [];
  private readonly rings: TimedObject[] = [];
  private readonly shotOrigins = new Map<number, THREE.Vector3>();
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly tempStart = new THREE.Vector3();
  private readonly tempEnd = new THREE.Vector3();
  private cursor = 0;
  private settings: SaveDataV1['settings'];

  constructor(materials: MaterialLibrary, settings: SaveDataV1['settings']) {
    this.settings = settings;
    this.root.name = 'Pooled Combat FX';
    this.createPools(materials);
  }

  updateSettings(settings: SaveDataV1['settings']): void {
    this.settings = settings;
  }

  consume(events: readonly GameEvent[], nowSeconds: number, playerId?: number): void {
    for (const event of events) {
      if (event.kind === 'shot' && event.position) {
        this.shotOrigins.set(event.tick, this.tempStart.fromArray(event.position).clone());
        if (!this.settings.reducedMotion) this.spawnShell(event.position, nowSeconds, event.id);
      }
      // Incoming fire gets a trace from the shooter's muzzle to wherever the shot
      // landed, so a miss is as readable as a hit and the source is locatable.
      if (event.kind === 'enemyAttack' && event.position && event.origin) {
        this.spawnTracer(this.tempStart.fromArray(event.origin), this.tempEnd.fromArray(event.position), ENEMY_TRACER_COLOR, nowSeconds);
        this.spawnImpact(event.position, event.normal, ENEMY_TRACER_COLOR, nowSeconds);
      }
      if ((event.kind === 'impact' || event.kind === 'hit') && event.position) {
        // Damage the player took carries the camera position, so treating it as a
        // world impact detonated a ring and sparks inside their own near plane. The
        // HUD owns that feedback instead.
        const target = event.targetEntityId ?? event.entityId;
        if (playerId !== undefined && target === playerId) continue;
        const color = event.kind === 'hit' ? HIT_COLOR : event.surface === 'wall-run' ? WALL_IMPACT_COLOR : IMPACT_COLOR;
        this.spawnImpact(event.position, event.normal, color, nowSeconds);
        const origin = this.shotOrigins.get(event.tick);
        if (origin) {
          this.spawnTracer(origin, this.tempEnd.fromArray(event.position), color, nowSeconds);
          this.shotOrigins.delete(event.tick);
        }
      }
      if ((event.kind === 'grappleAttach' || event.kind === 'grapplePull' || event.kind === 'grappleRelease' || event.kind === 'checkpoint' || event.kind === 'gateOpen') && event.position) {
        this.spawnRing(event.position, event.kind === 'grappleRelease' ? '#ffffff' : '#55f4ff', nowSeconds, event.kind === 'checkpoint' ? 0.8 : 0.38);
      }
    }
    for (const [tick] of this.shotOrigins) if (events.length && tick < events[events.length - 1].tick - 2) this.shotOrigins.delete(tick);
  }

  update(nowSeconds: number, deltaSeconds: number): void {
    this.updatePool(this.tracers, nowSeconds, (slot, progress) => {
      ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - progress;
      slot.object.scale.x = slot.object.scale.z = Math.max(0.05, 1 - progress);
    });
    this.updatePool(this.impacts, nowSeconds, (slot, progress) => {
      slot.object.scale.setScalar(0.6 + progress * 1.8);
      const mesh = slot.object as THREE.Mesh;
      (mesh.material as THREE.MeshBasicMaterial).opacity = (1 - progress) * 0.82;
    });
    this.updatePool(this.sparks, nowSeconds, (slot, progress) => {
      slot.velocity.y -= 11 * deltaSeconds;
      slot.object.position.addScaledVector(slot.velocity, deltaSeconds);
      slot.object.scale.y = 1 - progress;
      ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - progress;
    });
    this.updatePool(this.shells, nowSeconds, (slot, progress) => {
      slot.velocity.y -= 8.5 * deltaSeconds;
      slot.object.position.addScaledVector(slot.velocity, deltaSeconds);
      slot.object.rotation.x += slot.spin.x * deltaSeconds;
      slot.object.rotation.y += slot.spin.y * deltaSeconds;
      slot.object.rotation.z += slot.spin.z * deltaSeconds;
      const material = (slot.object as THREE.Mesh).material as THREE.MeshStandardMaterial;
      material.opacity = progress > 0.72 ? 1 - (progress - 0.72) / 0.28 : 1;
    });
    this.updatePool(this.rings, nowSeconds, (slot, progress) => {
      slot.object.scale.setScalar(0.4 + progress * 3.4);
      ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (1 - progress) * 0.85;
    });
  }

  dispose(): void {
    for (const pool of [this.tracers, this.impacts, this.sparks, this.shells, this.rings]) {
      for (const slot of pool) {
        this.root.remove(slot.object);
        slot.object.traverse((object) => {
          if (object instanceof THREE.Mesh) object.geometry.dispose();
        });
      }
    }
    this.ownedMaterials.forEach((material) => material.dispose());
    this.shotOrigins.clear();
  }

  private createPools(materials: MaterialLibrary): void {
    const tracerGeometry = new THREE.CylinderGeometry(0.008, 0.014, 1, 5);
    const impactGeometry = new THREE.RingGeometry(0.035, 0.08, 12);
    const sparkGeometry = new THREE.ConeGeometry(0.012, 0.26, 3);
    const shellGeometry = new THREE.CylinderGeometry(0.018, 0.018, 0.075, 8);
    const ringGeometry = new THREE.RingGeometry(0.12, 0.15, 28);
    for (let index = 0; index < 24; index += 1) {
      const tracerMaterial = new THREE.MeshBasicMaterial({ color: '#ffe9a8', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(tracerMaterial);
      this.tracers.push(this.slot(new THREE.Mesh(tracerGeometry, tracerMaterial)));
    }
    for (let index = 0; index < 24; index += 1) {
      const impactMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(impactMaterial);
      this.impacts.push(this.slot(new THREE.Mesh(impactGeometry, impactMaterial)));
    }
    // A shotgun shell is eight impacts of six sparks each, which filled the old
    // 48-slot pool exactly and made `acquire` steal from live sparks.
    for (let index = 0; index < 96; index += 1) {
      const sparkMaterial = new THREE.MeshBasicMaterial({ color: '#ffd58c', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(sparkMaterial);
      this.sparks.push(this.slot(new THREE.Mesh(sparkGeometry, sparkMaterial)));
    }
    for (let index = 0; index < 18; index += 1) {
      const shellMaterial = materials.get('amber-light').clone();
      shellMaterial.transparent = true;
      shellMaterial.opacity = 0;
      this.ownedMaterials.push(shellMaterial);
      this.shells.push(this.slot(new THREE.Mesh(shellGeometry, shellMaterial)));
    }
    for (let index = 0; index < 10; index += 1) {
      const ringMaterial = new THREE.MeshBasicMaterial({ color: '#55f4ff', transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(ringMaterial);
      this.rings.push(this.slot(new THREE.Mesh(ringGeometry, ringMaterial)));
    }
  }

  private spawnTracer(start: THREE.Vector3, end: THREE.Vector3, color: THREE.Color, now: number): void {
    const slot = this.acquire(this.tracers, now, 0.085);
    const midpoint = start.clone().lerp(end, 0.5);
    const length = Math.max(0.01, start.distanceTo(end));
    slot.object.position.copy(midpoint);
    slot.object.scale.set(1, length, 1);
    slot.object.quaternion.setFromUnitVectors(UP, end.clone().sub(start).normalize());
    ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(color).lerp(TRACER_TINT, 0.55);
  }

  private spawnImpact(position: readonly [number, number, number], normal: readonly [number, number, number] | undefined, color: THREE.Color, now: number): void {
    const slot = this.acquire(this.impacts, now, 0.42);
    slot.object.position.fromArray(position);
    const direction = normal ? this.tempEnd.fromArray(normal).normalize() : this.tempEnd.set(0, 1, 0);
    slot.object.position.addScaledVector(direction, 0.008);
    slot.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(color);
    const count = this.settings.reducedMotion ? 2 : 6;
    for (let index = 0; index < count; index += 1) {
      const spark = this.acquire(this.sparks, now, 0.22 + (index % 3) * 0.06);
      spark.object.position.fromArray(position);
      const angle = ((index + this.cursor) / count) * Math.PI * 2;
      spark.velocity.set(Math.cos(angle) * (1.5 + index * 0.15), 1.6 + (index % 2) * 1.1, Math.sin(angle) * (1.5 + index * 0.13));
      spark.object.quaternion.setFromUnitVectors(UP, spark.velocity.clone().normalize());
      ((spark.object as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(color);
    }
  }

  private spawnShell(position: readonly [number, number, number], now: number, seed: number): void {
    const slot = this.acquire(this.shells, now, 1.15);
    slot.object.position.fromArray(position);
    const pseudo = ((seed * 48271) % 2147483647) / 2147483647;
    slot.velocity.set(1.1 + pseudo * 0.7, 1.6 + pseudo * 0.45, 0.35 - pseudo * 0.7);
    slot.spin.set(8 + pseudo * 4, 13 - pseudo * 5, 9 + pseudo * 6);
  }

  private spawnRing(position: readonly [number, number, number], color: THREE.ColorRepresentation, now: number, lifetime: number): void {
    const slot = this.acquire(this.rings, now, lifetime);
    slot.object.position.fromArray(position);
    slot.object.rotation.x = -Math.PI / 2;
    ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(color);
  }

  private slot(object: THREE.Object3D): TimedObject {
    object.visible = false;
    this.root.add(object);
    return { object, bornAt: 0, expiresAt: 0, active: false, velocity: new THREE.Vector3(), spin: new THREE.Vector3() };
  }

  private acquire(pool: TimedObject[], now: number, lifetime: number): TimedObject {
    const slot = pool.find((candidate) => !candidate.active) ?? pool[this.cursor++ % pool.length];
    slot.active = true;
    slot.bornAt = now;
    slot.expiresAt = now + lifetime;
    slot.object.visible = true;
    slot.object.scale.set(1, 1, 1);
    return slot;
  }

  private updatePool(pool: TimedObject[], now: number, update: (slot: TimedObject, progress: number) => void): void {
    for (const slot of pool) {
      if (!slot.active) continue;
      if (now >= slot.expiresAt) {
        slot.active = false;
        slot.object.visible = false;
        continue;
      }
      update(slot, (now - slot.bornAt) / (slot.expiresAt - slot.bornAt));
    }
  }
}
