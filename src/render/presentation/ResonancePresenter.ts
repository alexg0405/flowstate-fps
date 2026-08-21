import * as THREE from 'three';
import type { SaveDataV1, SimulationSnapshot } from '../../contracts';
import { resonanceAccent } from '../palette';

/** How many Resonators may be drawing at once. Two per arena is already a lot to read. */
const POOL = 4;

/**
 * The Resonator's warning, and its wave, drawn on the deck.
 *
 * This is the one hostile marking in the game that has to be read *positionally* -- not
 * "there is a threat" but "the threat is **there**, and it will be **here**". A HUD
 * cannot say that, and the project's own rule keeps everything out of fifteen degrees of
 * the crosshair anyway, so the floor is the only surface that can carry it.
 *
 * State-driven rather than event-driven, which is why it is its own presenter rather than
 * a pool in `FxPresenter`. An impact is a thing that happened and can be fired and
 * forgotten; a wave is a thing that is *currently true*, published every tick as a radius,
 * and the drawing has to follow it. `GrapplePresenter` and `GhostPresenter` are the same
 * shape for the same reason.
 *
 * Two rings per hostile:
 *
 * - **The warning** contracts inward under the emitter through the telegraph, which is
 *   the opposite direction to the wave. A warning that expanded would read as the attack
 *   already happening; one that contracts reads as winding up, and the two can never be
 *   confused at a glance even when both are on screen.
 * - **The wave** is the published radius, flat on the deck, thickness and all. It is
 *   drawn at the *emitter's* foot height rather than the player's, because that is the
 *   plane the damage check uses -- a ring drawn anywhere else would be lying about which
 *   height clears it.
 *
 * Additive and untonemapped, like the grapple marker: this is a signal, not a surface,
 * and it must stay legible against a near-black deck. Under reduced motion the rings are
 * still drawn -- the warning is information, not decoration -- but they stop pulsing.
 */
export class ResonancePresenter {
  readonly root = new THREE.Group();
  private readonly warnings: THREE.Mesh[] = [];
  private readonly waves: THREE.Mesh[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private settings: SaveDataV1['settings'];

  constructor(settings: SaveDataV1['settings']) {
    this.settings = settings;
    this.root.name = 'Resonance';
    for (let index = 0; index < POOL; index += 1) {
      this.warnings.push(this.createRing(0.55, 0.72, 0.9));
      this.waves.push(this.createRing(0.86, 1, 0.72));
    }
    this.root.add(...this.warnings, ...this.waves);
  }

  updateSettings(settings: SaveDataV1['settings']): void {
    this.settings = settings;
  }

  /**
   * A unit ring lying in the XZ plane, so a radius is a uniform scale.
   *
   * `inner` and `outer` are fractions of that unit, which is what lets one geometry serve
   * both a thin warning and a thick wave band without a second allocation per hostile.
   */
  private createRing(inner: number, outer: number, opacity: number): THREE.Mesh {
    const geometry = new THREE.RingGeometry(inner, outer, 64);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(resonanceAccent),
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.geometries.push(geometry);
    this.materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.renderOrder = 2;
    return mesh;
  }

  update(snapshot: SimulationSnapshot, time: number, footHeight: number): void {
    let slot = 0;
    for (const entity of snapshot.entities) {
      if (entity.profile !== 'resonator' || slot >= POOL) continue;
      if (entity.telegraph === undefined && !entity.pulse) continue;
      const warning = this.warnings[slot];
      const wave = this.waves[slot];
      const [x, y, z] = entity.position;
      const deck = y - footHeight;

      warning.visible = entity.telegraph !== undefined;
      if (entity.telegraph !== undefined) {
        // Contracts from the wave's own reach down to almost nothing, so the last thing
        // the player sees before it fires is a point under the emitter's feet.
        const span = 1 - entity.telegraph;
        const radius = 0.6 + span * 3.4;
        warning.position.set(x, deck + 0.04, z);
        warning.scale.setScalar(radius);
        const material = warning.material as THREE.MeshBasicMaterial;
        // Brightens as it closes, and holds steady under reduced motion.
        const flicker = this.settings.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(time * 34);
        material.opacity = (0.35 + 0.65 * entity.telegraph) * flicker;
      }

      wave.visible = Boolean(entity.pulse);
      if (entity.pulse) {
        const { radius, reach, thickness } = entity.pulse;
        // Scaled to the band's outer edge, so the leading edge of what is drawn is the
        // leading edge of what the damage check uses.
        //
        // One shared geometry means the inner radius is a fixed fraction, so the band
        // reads as proportionally thinner the further out it gets rather than holding
        // `thickness` in metres. Taken deliberately: a shockwave thinning as it spreads
        // is the right read, the leading edge is the part the player times against, and
        // it costs no per-hostile allocation.
        wave.position.set(x, deck + 0.03, z);
        wave.scale.setScalar(Math.max(0.001, radius + thickness / 2));
        (wave.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - radius / reach) + 0.12;
      }
      slot += 1;
    }
    for (let index = slot; index < POOL; index += 1) {
      this.warnings[index].visible = false;
      this.waves[index].visible = false;
    }
  }

  dispose(): void {
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }
}
