import * as THREE from 'three';
import type { SaveDataV1, Vec3 } from '../../contracts';

/**
 * The record run, drawn as a translucent racer. It has to be findable from across an
 * arena without ever being mistaken for a hostile, so it is cyan, unlit, and carries a
 * vertical beam that stays visible when the body itself is behind geometry.
 */
export class GhostPresenter {
  readonly root = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly beam: THREE.Mesh;
  private readonly pad: THREE.Mesh;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly target = new THREE.Vector3();
  private readonly bodyMaterial: THREE.MeshBasicMaterial;
  private readonly beamMaterial: THREE.MeshBasicMaterial;
  private readonly padMaterial: THREE.MeshBasicMaterial;
  private settings: SaveDataV1['settings'];
  private seeded = false;

  constructor(settings: SaveDataV1['settings']) {
    this.settings = settings;
    this.root.name = 'Record Ghost';
    this.root.visible = false;

    const bodyGeometry = new THREE.CapsuleGeometry(0.34, 1.1, 6, 12);
    const bodyMaterial = new THREE.MeshBasicMaterial({
      color: '#5ef7ff', transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.body = new THREE.Mesh(bodyGeometry, bodyMaterial);


    const beamGeometry = new THREE.CylinderGeometry(0.035, 0.035, 26, 6, 1, true);
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: '#5ef7ff', transparent: true, opacity: 0, depthWrite: false,
      // Drawn through geometry on purpose: the point of the beam is to be findable.
      depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    this.beam = new THREE.Mesh(beamGeometry, beamMaterial);
    this.beam.position.y = 12;
    this.beam.renderOrder = 2;

    const padGeometry = new THREE.RingGeometry(0.42, 0.58, 24);
    const padMaterial = new THREE.MeshBasicMaterial({
      color: '#5ef7ff', transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.pad = new THREE.Mesh(padGeometry, padMaterial);
    this.pad.rotation.x = -Math.PI / 2;
    this.pad.position.y = -0.9;

    this.bodyMaterial = bodyMaterial;
    this.beamMaterial = beamMaterial;
    this.padMaterial = padMaterial;
    this.ownedGeometries.push(bodyGeometry, beamGeometry, padGeometry);
    this.ownedMaterials.push(bodyMaterial, beamMaterial, padMaterial);
    this.root.add(this.body, this.beam, this.pad);
  }

  updateSettings(settings: SaveDataV1['settings']): void {
    this.settings = settings;
  }

  update(position: Vec3 | null, cameraPosition: Vec3, time: number, deltaSeconds: number): void {
    this.root.visible = position !== null;
    if (!position) {
      this.seeded = false;
      return;
    }
    this.target.set(position[0], position[1], position[2]);
    // Snap on the first frame; smoothing from wherever the group happened to sit would
    // fly the ghost in from the origin.
    if (!this.seeded || deltaSeconds <= 0) {
      this.root.position.copy(this.target);
      this.seeded = true;
    } else {
      this.root.position.lerp(this.target, Math.min(1, deltaSeconds * 18));
    }
    const pulse = this.settings.reducedMotion ? 1 : 1 + Math.sin(time * 3.4) * 0.06;
    this.body.scale.setScalar(pulse);
    this.pad.rotation.z = this.settings.reducedMotion ? 0 : time * 0.9;

    // Faded out at close range. Being level with the record is the good case, and an
    // additive blob at arm's length would blind the player for achieving it. It also
    // means the beam only appears once the ghost is far enough away to need finding.
    const distance = Math.hypot(
      this.root.position.x - cameraPosition[0],
      this.root.position.y - cameraPosition[1],
      this.root.position.z - cameraPosition[2],
    );
    const nearness = THREE.MathUtils.smoothstep(distance, 1.6, 5);
    this.bodyMaterial.opacity = 0.2 * nearness;
    this.padMaterial.opacity = 0.34 * nearness;
    this.beamMaterial.opacity = 0.06 * nearness;
  }

  dispose(): void {
    this.ownedGeometries.forEach((geometry) => geometry.dispose());
    this.ownedMaterials.forEach((material) => material.dispose());
  }
}
