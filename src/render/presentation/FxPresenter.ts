import * as THREE from 'three';
import type { GameEvent, SaveDataV1 } from '../../contracts';
import { MaterialLibrary, rebindGraphicShading } from './MaterialLibrary';
import { angularRing, fracture, shard, starBurst, type FlatShape } from './graphicShapes';

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

/**
 * Combat, drawn rather than simulated.
 *
 * The vocabulary is in `graphicShapes` and the reason it changed is in `RENDER.md`: an
 * impact used to be a soft ring scaling up and fading, which is a renderer describing
 * expanding gas. It is now three things in sequence -- a white angular flash for two
 * frames, a hard-edged dark fracture left in the surface, and flat shards thrown off it
 * -- which is the same event drawn the way an animator would draw it.
 *
 * The pooling, the event wiring and the lifetimes are unchanged. What changed is the
 * geometry, the blending and the envelopes.
 */
export class FxPresenter {
  readonly root = new THREE.Group();
  private readonly tracers: TimedObject[] = [];
  private readonly impacts: TimedObject[] = [];
  private readonly fractures: TimedObject[] = [];
  private readonly sparks: TimedObject[] = [];
  private readonly shells: TimedObject[] = [];
  private readonly rings: TimedObject[] = [];
  private readonly flashes: TimedObject[] = [];
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
        // The flash at the far end is what makes incoming fire locatable at a glance:
        // the trace says where it went, and two frames of hard white say where it came
        // from. The player's own muzzle is `ViewmodelPresenter`'s.
        this.spawnFlash(event.origin, ENEMY_TRACER_COLOR, nowSeconds);
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
    // Two frames at full size and then gone. A flash that fades is a light source; a
    // flash that is simply not there next frame is a drawing.
    this.updatePool(this.flashes, nowSeconds, (slot, progress) => {
      ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = progress < 0.62 ? 1 : 0;
      slot.object.scale.setScalar(slot.spin.x * (progress < 0.3 ? 1 : 1.35));
    });
    this.updatePool(this.impacts, nowSeconds, (slot, progress) => {
      // The white half: it pops out and stops, rather than expanding for its whole life.
      slot.object.scale.setScalar(0.7 + Math.min(1, progress * 5) * 1.1);
      ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = progress < 0.22 ? 1 : Math.max(0, 1 - (progress - 0.22) / 0.3);
    });
    // The dark half, and the only thing in the game drawn darker than what is behind it.
    // It arrives at full size under the flash and outlives it.
    this.updatePool(this.fractures, nowSeconds, (slot, progress) => {
      slot.object.scale.setScalar(0.55 + Math.min(1, progress * 3.5) * 0.5);
      ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (1 - progress) * 0.86;
    });
    this.updatePool(this.sparks, nowSeconds, (slot, progress) => {
      slot.velocity.y -= 11 * deltaSeconds;
      slot.object.position.addScaledVector(slot.velocity, deltaSeconds);
      // A shard tumbles and shrinks along its length rather than fading out: it is a
      // shape leaving the frame, not a light going out.
      slot.object.rotation.z += slot.spin.z * deltaSeconds;
      slot.object.scale.set(1, Math.max(0.05, 1 - progress), 1);
      ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = progress < 0.7 ? 0.95 : (1 - progress) / 0.3;
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
    for (const pool of [this.tracers, this.impacts, this.fractures, this.sparks, this.shells, this.rings, this.flashes]) {
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
    const shellGeometry = new THREE.CylinderGeometry(0.018, 0.018, 0.075, 8);
    const ringGeometry = flat(angularRing(6, 0.82), 0.15);
    for (let index = 0; index < 24; index += 1) {
      const tracerMaterial = new THREE.MeshBasicMaterial({ color: '#ffe9a8', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(tracerMaterial);
      this.tracers.push(this.slot(new THREE.Mesh(tracerGeometry, tracerMaterial)));
    }
    // Every star in each pool is generated from its own seed, so the vocabulary is one
    // shape and the frame never shows the same instance of it twice.
    for (let index = 0; index < 24; index += 1) {
      const impactMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(impactMaterial);
      this.impacts.push(this.slot(new THREE.Mesh(flat(starBurst(7, 0.3, index), 0.085), impactMaterial)));
    }
    for (let index = 0; index < 16; index += 1) {
      const flashMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(flashMaterial);
      this.flashes.push(this.slot(new THREE.Mesh(flat(starBurst(5, 0.22, index + 91), 0.24), flashMaterial)));
    }
    // Normal blending, not additive: this is the one effect in the game that has to be
    // able to draw *darker* than the surface it sits on.
    for (let index = 0; index < 24; index += 1) {
      const fractureMaterial = new THREE.MeshBasicMaterial({ color: '#05080c', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(fractureMaterial);
      this.fractures.push(this.slot(new THREE.Mesh(flat(fracture(6, index + 17), 0.105), fractureMaterial)));
    }
    // A shotgun shell is eight impacts of six shards each, which filled the old
    // 48-slot pool exactly and made `acquire` steal from live ones.
    for (let index = 0; index < 96; index += 1) {
      const sparkMaterial = new THREE.MeshBasicMaterial({ color: '#ffd58c', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(sparkMaterial);
      this.sparks.push(this.slot(new THREE.Mesh(flat(shard(index), 0.2), sparkMaterial)));
    }
    for (let index = 0; index < 18; index += 1) {
      const shellMaterial = rebindGraphicShading(materials.get('amber-light').clone()) as THREE.MeshToonMaterial;
      shellMaterial.transparent = true;
      shellMaterial.opacity = 0;
      this.ownedMaterials.push(shellMaterial);
      this.shells.push(this.slot(new THREE.Mesh(shellGeometry, shellMaterial)));
    }
    for (let index = 0; index < 10; index += 1) {
      const ringMaterial = new THREE.MeshBasicMaterial({ color: '#55f4ff', transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.ownedMaterials.push(ringMaterial);
      this.rings.push(this.slot(new THREE.Mesh(ringGeometry.clone(), ringMaterial)));
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

  /**
   * White flash, dark fracture, coloured shards -- in that order, on the same tick. The
   * three of them are one event; splitting them is what lets the flash be two frames long
   * while the mark it leaves outlives it.
   */
  private spawnImpact(position: readonly [number, number, number], normal: readonly [number, number, number] | undefined, color: THREE.Color, now: number): void {
    const direction = normal ? this.tempEnd.fromArray(normal).normalize().clone() : new THREE.Vector3(0, 1, 0);
    const facing = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);

    const slot = this.acquire(this.impacts, now, 0.3);
    slot.object.position.fromArray(position).addScaledVector(direction, 0.012);
    slot.object.quaternion.copy(facing);
    slot.object.rotateZ(this.cursor * 1.31);
    ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(color);

    const mark = this.acquire(this.fractures, now, 0.5);
    mark.object.position.fromArray(position).addScaledVector(direction, 0.006);
    mark.object.quaternion.copy(facing);
    mark.object.rotateZ(this.cursor * 0.77);

    const count = this.settings.reducedMotion ? 2 : 6;
    for (let index = 0; index < count; index += 1) {
      const spark = this.acquire(this.sparks, now, 0.26 + (index % 3) * 0.06);
      spark.object.position.fromArray(position);
      const angle = ((index + this.cursor) / count) * Math.PI * 2;
      spark.velocity.set(Math.cos(angle) * (1.5 + index * 0.15), 1.6 + (index % 2) * 1.1, Math.sin(angle) * (1.5 + index * 0.13));
      spark.object.quaternion.setFromUnitVectors(UP, spark.velocity.clone().normalize());
      spark.spin.set(0, 0, 6 + (index % 4) * 3);
      ((spark.object as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(color);
    }
  }

  /**
   * A muzzle, for two frames. Billboarded rather than oriented, because a flash is a
   * shape on the frame and not a thing standing in the world.
   */
  private spawnFlash(position: readonly [number, number, number], color: THREE.Color, now: number): void {
    if (this.settings.reducedMotion) return;
    const slot = this.acquire(this.flashes, now, 0.075);
    slot.object.position.fromArray(position);
    slot.object.rotation.set(0, 0, this.cursor * 0.91);
    // Carried on the spin vector because a flash has no velocity to keep there.
    // The flash pops one step wider halfway through its two frames; the base size is
    // already in the geometry, so this is a multiplier rather than a size.
    slot.spin.set(1, 0, 0);
    slot.object.scale.setScalar(1);
    ((slot.object as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(color).lerp(TRACER_TINT, 0.5);
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
    slot.object.rotation.set(-Math.PI / 2, 0, this.cursor * 0.4);
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

/**
 * One of `graphicShapes`' flat shapes as geometry, at a world size.
 *
 * The shapes are authored at unit radius so their proportions are readable on their own
 * terms; the sizes below are the metres they actually occupy, and they are the numbers the
 * ring and cone geometry this replaced was carrying.
 */
function flat(shape: FlatShape, metres: number): THREE.BufferGeometry {
  const positions = new Float32Array(shape.positions.length);
  for (let index = 0; index < positions.length; index += 1) positions[index] = shape.positions[index] * metres;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
