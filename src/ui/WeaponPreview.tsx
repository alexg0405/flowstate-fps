import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { WeaponChassisId, WeaponPartSlot } from '../contracts';
import { MaterialLibrary } from '../render/presentation/MaterialLibrary';
import { ViewmodelPresenter } from '../render/presentation/ViewmodelPresenter';

/** Turntable speed in radians a second, and the angle it is parked at without it. */
const SPIN_RATE = 0.36;
const PARKED_YAW = -0.72;
/** How much room to leave around the weapon once it has been measured. */
const FRAMING = 1.2;

/**
 * Bounds of what is actually drawn. `Box3.setFromObject` measures hidden nodes too,
 * and the presenter carries a pair of arms and a muzzle flash that are switched off
 * here -- measuring those framed the weapon at a third of the size it should be.
 */
function visibleBounds(root: THREE.Object3D, target: THREE.Box3): THREE.Box3 {
  target.makeEmpty();
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const visit = (object: THREE.Object3D) => {
    if (!object.visible) return;
    if (object instanceof THREE.Mesh && object.geometry) {
      object.geometry.computeBoundingBox();
      if (object.geometry.boundingBox) target.union(box.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld));
    }
    for (const child of object.children) visit(child);
  };
  visit(root);
  return target;
}

interface WeaponPreviewProps {
  chassisId: WeaponChassisId;
  parts: Partial<Record<WeaponPartSlot, string>>;
  reducedMotion?: boolean;
}

/**
 * The build, in 3D, on a turntable.
 *
 * It drives the game's own `ViewmodelPresenter`, so fitting a drum magazine or a
 * long barrel reshapes the same model the run puts in the player's hands rather
 * than an illustration of it that could drift.
 *
 * WebGL is treated as optional. The builder is reachable from the menu, from the
 * pause overlay and from a jsdom test, and none of those may fail because a context
 * could not be created -- the bench falls back to a static plate.
 */
export function WeaponPreview({ chassisId, parts, reducedMotion = false }: WeaponPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const presenterRef = useRef<ViewmodelPresenter | null>(null);
  const frameRef = useRef<(() => void) | null>(null);
  const motionRef = useRef(reducedMotion);
  const [available, setAvailable] = useState(true);

  motionRef.current = reducedMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Checked before touching the canvas so a headless DOM never has to fail a
    // context request to tell us it has no WebGL.
    if (typeof WebGL2RenderingContext === 'undefined') {
      setAvailable(false);
      return;
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      // No context: the panel shows its fallback and nothing else is constructed.
      setAvailable(false);
      return;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 12);
    const pivot = new THREE.Group();
    scene.add(pivot);

    // Metal reads as black without something to reflect, so the preview borrows the
    // same room probe the game lights its viewmodel with.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const probe = pmrem.fromScene(room, 0.04);
    scene.environment = probe.texture;
    scene.environmentIntensity = 0.9;
    room.dispose();
    pmrem.dispose();

    const key = new THREE.DirectionalLight('#dff0ff', 3.4);
    key.position.set(-2.4, 3.2, 2.8);
    const fill = new THREE.DirectionalLight('#08f7ff', 1.1);
    fill.position.set(2.6, -1.2, 2.2);
    const rim = new THREE.DirectionalLight('#ff426d', 1.8);
    rim.position.set(3.2, 0.6, -2.4);
    scene.add(new THREE.HemisphereLight('#9fd0e8', '#0b0f16', 1.1), key, fill, rim);

    const materials = new MaterialLibrary(renderer);
    // The bench never sways, bobs or shakes: those settings belong to a run.
    const presenter = new ViewmodelPresenter(materials, {
      sensitivity: 0.002, fov: 92, cameraRoll: 0, headBob: 0, shake: 0, renderScale: 1, debug: false,
      graphicsQuality: 'high', dynamicResolution: false, reducedMotion: true,
    });
    presenter.setHandsVisible(false);
    presenter.root.position.set(0, 0, 0);
    presenter.root.rotation.set(0, 0, 0);
    pivot.add(presenter.root);
    presenterRef.current = presenter;

    const bounds = new THREE.Box3();
    const centre = new THREE.Vector3();
    const size = new THREE.Vector3();
    /** Re-frames after a build change, since parts move the silhouette. */
    const frame = () => {
      pivot.rotation.y = 0;
      presenter.root.position.set(0, 0, 0);
      visibleBounds(presenter.root, bounds);
      if (bounds.isEmpty()) return;
      bounds.getCenter(centre);
      bounds.getSize(size);
      presenter.root.position.set(-centre.x, -centre.y, -centre.z);
      // Framed on the horizontal sweep, since the turntable presents the weapon's
      // length to the camera for most of a rotation.
      const radius = Math.max(Math.hypot(size.x, size.z) * 0.5, size.y * 0.75);
      const distance = (radius * FRAMING) / Math.tan((camera.fov * Math.PI) / 360);
      camera.position.set(distance * 0.22, radius * 0.42, distance);
      camera.lookAt(0, 0, 0);
    };
    frameRef.current = frame;
    frame();

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    let animation = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.05, (now - last) / 1000);
      last = now;
      // Reduced motion parks the turntable at a three-quarter angle instead of
      // spinning it, so the same information is there without the movement.
      pivot.rotation.y = motionRef.current ? PARKED_YAW : pivot.rotation.y + SPIN_RATE * delta;
      renderer.render(scene, camera);
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animation);
      observer.disconnect();
      frameRef.current = null;
      presenterRef.current = null;
      presenter.dispose();
      materials.dispose();
      probe.dispose();
      renderer.dispose();
    };
  }, []);

  useEffect(() => {
    presenterRef.current?.applyBuild(chassisId, parts);
    frameRef.current?.();
  }, [chassisId, parts]);

  if (!available) {
    return (
      <div className="weapon-stage is-unavailable" role="img" aria-label="Weapon preview unavailable">
        <span className="micro-label">PREVIEW OFFLINE</span>
        <strong>No 3D context</strong>
      </div>
    );
  }

  return (
    <div className="weapon-stage">
      <canvas ref={canvasRef} className="weapon-stage-canvas" aria-label="Weapon preview" />
      <span className="stage-corner tl" aria-hidden="true" />
      <span className="stage-corner br" aria-hidden="true" />
    </div>
  );
}
