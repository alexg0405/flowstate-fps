import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { SaveDataV1, SimulationSnapshot } from '../../contracts';
import { MaterialLibrary } from './MaterialLibrary';

const POINT_COUNT = 32;

export class GrapplePresenter {
  readonly root = new THREE.Group();
  private readonly cableGeometry = new LineGeometry();
  private readonly glowGeometry = new LineGeometry();
  private readonly cableMaterial = new LineMaterial({ color: 0x172b36, linewidth: 3.2, worldUnits: false, transparent: true, opacity: 0.96, depthTest: true });
  private readonly glowMaterial = new LineMaterial({ color: 0x5ef7ff, linewidth: 1.15, worldUnits: false, transparent: true, opacity: 0.92, depthTest: true });
  private readonly cable = new Line2(this.cableGeometry, this.cableMaterial);
  private readonly glow = new Line2(this.glowGeometry, this.glowMaterial);
  private readonly marker = new THREE.Group();
  /** Preview of where a cast would land, shown before the player commits. */
  private readonly aimMarker = new THREE.Group();
  private readonly aimRing: THREE.Mesh;
  private readonly aimRingMaterial: THREE.MeshBasicMaterial;
  private readonly aimGeometries: THREE.BufferGeometry[] = [];
  private readonly positions = new Float32Array(POINT_COUNT * 3);
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly cameraOffset = new THREE.Vector3();
  private readonly cameraEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private settings: SaveDataV1['settings'];

  constructor(materials: MaterialLibrary, settings: SaveDataV1['settings']) {
    this.settings = settings;
    this.root.name = 'Grapple Cable';
    this.buildMarker(materials);
    const ringGeometry = new THREE.RingGeometry(0.2, 0.3, 5);
    this.aimRingMaterial = new THREE.MeshBasicMaterial({
      color: 0x5ef7ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.aimRing = new THREE.Mesh(ringGeometry, this.aimRingMaterial);
    this.aimGeometries.push(ringGeometry);
    this.aimMarker.add(this.aimRing);
    this.aimMarker.visible = false;
    this.root.add(this.cable, this.glow, this.marker);
    this.root.visible = false;
  }

  /** Root for the aim preview, which has to stay visible while the cable root is not. */
  get aimRoot(): THREE.Group {
    return this.aimMarker;
  }

  /**
   * Faces the marker at the camera and colours it by whether the cast would be taken.
   * Refused casts are still shown: knowing a surface is too close is information.
   */
  updateAim(snapshot: SimulationSnapshot, time: number): void {
    const aim = snapshot.player.grapple.aim;
    const show = Boolean(aim) && !snapshot.player.grapple.active;
    this.aimMarker.visible = show;
    if (!aim || !show) return;
    this.aimMarker.position.fromArray(aim.point);
    this.aimMarker.lookAt(
      snapshot.camera.position[0],
      snapshot.camera.position[1],
      snapshot.camera.position[2],
    );
    this.aimRingMaterial.color.setHex(aim.valid ? 0x5ef7ff : 0xff2f4d);
    this.aimRingMaterial.opacity = aim.valid ? 0.85 : 0.4;
    // Scaled with distance so it stays a readable size down a long corridor.
    const distance = Math.hypot(
      aim.point[0] - snapshot.camera.position[0],
      aim.point[1] - snapshot.camera.position[1],
      aim.point[2] - snapshot.camera.position[2],
    );
    const spin = this.settings.reducedMotion ? 0 : time * 1.6;
    this.aimMarker.rotateZ(spin);
    this.aimMarker.scale.setScalar(0.5 + distance * 0.05);
  }

  updateSettings(settings: SaveDataV1['settings']): void {
    this.settings = settings;
  }

  resize(width: number, height: number): void {
    this.cableMaterial.resolution.set(width, height);
    this.glowMaterial.resolution.set(width, height);
  }

  update(snapshot: SimulationSnapshot, time: number, emitterCameraOffset?: THREE.Vector3): void {
    const anchor = snapshot.player.grapple.anchor;
    this.root.visible = Boolean(anchor);
    if (!anchor) return;
    this.start.fromArray(snapshot.camera.position);
    this.cameraEuler.set(snapshot.camera.pitch, snapshot.camera.yaw, 0, 'YXZ');
    this.cameraOffset.copy(emitterCameraOffset ?? this.cameraOffset.set(0.24, -0.18, -0.48)).applyEuler(this.cameraEuler);
    this.start.add(this.cameraOffset);
    this.end.fromArray(anchor);
    const speedStretch = THREE.MathUtils.clamp(snapshot.player.speed / 18, 0, 1);
    // The hook pulls in a straight line, so the cable is drawn as one too. A
    // sagging curve would advertise a swing the movement no longer has.
    for (let index = 0; index < POINT_COUNT; index += 1) {
      const t = index / (POINT_COUNT - 1);
      this.point.lerpVectors(this.start, this.end, t);
      const offset = index * 3;
      this.positions[offset] = this.point.x;
      this.positions[offset + 1] = this.point.y;
      this.positions[offset + 2] = this.point.z;
    }
    this.cableGeometry.setPositions(this.positions);
    this.glowGeometry.setPositions(this.positions);
    this.cable.computeLineDistances();
    this.glow.computeLineDistances();
    this.glowMaterial.opacity = 0.72 + speedStretch * 0.26;
    this.glowMaterial.linewidth = 0.9 + speedStretch * 0.65;
    this.glowMaterial.dashed = !this.settings.reducedMotion && speedStretch > 0.48;
    this.glowMaterial.dashScale = 1.8 + speedStretch * 2.5;
    this.glowMaterial.dashSize = 0.22;
    this.glowMaterial.gapSize = 0.12;
    this.glowMaterial.dashOffset = this.settings.reducedMotion ? 0 : -time * (0.9 + speedStretch * 2.6);
    this.marker.position.copy(this.end);
    const pulse = this.settings.reducedMotion ? 1 : 1 + Math.sin(time * 11) * 0.08;
    this.marker.scale.setScalar(pulse);
    this.marker.rotation.y = this.settings.reducedMotion ? 0 : time * 1.5;
  }

  dispose(): void {
    this.aimGeometries.forEach((geometry) => geometry.dispose());
    this.aimRingMaterial.dispose();
    this.cableGeometry.dispose();
    this.glowGeometry.dispose();
    this.cableMaterial.dispose();
    this.glowMaterial.dispose();
    this.marker.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }

  private buildMarker(materials: MaterialLibrary): void {
    for (let index = 0; index < 3; index += 1) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16 + index * 0.07, 0.018 - index * 0.003, 7, 24), index === 1 ? materials.get('cyan-light') : materials.get('gunmetal'));
      ring.rotation.set(index === 0 ? Math.PI / 2 : 0, index === 2 ? Math.PI / 2 : 0, index * 0.4);
      this.marker.add(ring);
    }
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.075, 1), materials.get('cyan-light'));
    this.marker.add(core);
  }
}
