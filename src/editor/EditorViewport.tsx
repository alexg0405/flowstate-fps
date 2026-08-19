import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { LevelDocumentV2, LightInstance, TransformData, Vec3, VisualInstance } from '../contracts';
import { createEditorAssetProxy } from './assetCatalogAdapter';
import { type CameraMode, useEditorStore } from './editorStore';

interface EditorViewportProps {
  document: LevelDocumentV2;
  selectedId: string | null;
  cameraMode: CameraMode;
  collisionProxiesVisible: boolean;
}

type EditorObjectKind = 'collision' | 'visual' | 'light' | 'spawn' | 'encounter' | 'link';

interface SceneRecord {
  id: string;
  kind: EditorObjectKind;
  object: THREE.Object3D;
  contentSignature: string;
}

interface ViewportCallbacks {
  select: (id: string | null) => void;
  commitTransform: (id: string, kind: EditorObjectKind, object: THREE.Object3D) => void;
}

export function EditorViewport({ document, selectedId, cameraMode, collisionProxiesVisible }: EditorViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<EditorViewportController | null>(null);
  const documentRef = useRef(document);
  const setSelected = useEditorStore((state) => state.setSelected);
  const updateCollision = useEditorStore((state) => state.updateCollision);
  const updateVisual = useEditorStore((state) => state.updateVisual);
  const updateLight = useEditorStore((state) => state.updateLight);
  const updateSpawn = useEditorStore((state) => state.updateSpawn);
  const updateEncounter = useEditorStore((state) => state.updateEncounter);

  documentRef.current = document;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const callbacks: ViewportCallbacks = {
      select: setSelected,
      commitTransform: (id, kind, object) => {
        const current = documentRef.current;
        if (kind === 'collision') {
          const item = current.collision.find((candidate) => candidate.id === id);
          if (item) updateCollision(id, { transform: transformFromObject(object) });
        } else if (kind === 'visual') {
          const item = current.visuals.find((candidate) => candidate.id === id);
          if (item) updateVisual(id, { transform: transformFromObject(object) });
        } else if (kind === 'light') {
          const item = current.lights.find((candidate) => candidate.id === id);
          if (item) updateLight(id, { transform: transformFromObject(object) });
        } else if (kind === 'spawn') {
          const item = current.spawns.find((candidate) => candidate.id === id);
          if (item) updateSpawn(id, { position: vec3(object.position), rotationY: object.rotation.y });
        } else if (kind === 'encounter') {
          const item = current.encounters.find((candidate) => candidate.id === id);
          if (item) updateEncounter(id, { checkpoint: vec3(object.position) });
        }
      },
    };
    const controller = new EditorViewportController(canvas, callbacks);
    controllerRef.current = controller;
    controller.syncDocument(documentRef.current);
    controller.setCollisionProxiesVisible(collisionProxiesVisible);
    controller.setCameraMode(cameraMode);
    controller.setSelected(selectedId);
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [setSelected, updateCollision, updateEncounter, updateLight, updateSpawn, updateVisual]);

  useEffect(() => { controllerRef.current?.syncDocument(document); }, [document]);
  useEffect(() => { controllerRef.current?.setSelected(selectedId); }, [selectedId]);
  useEffect(() => { controllerRef.current?.setCameraMode(cameraMode); }, [cameraMode]);
  useEffect(() => { controllerRef.current?.setCollisionProxiesVisible(collisionProxiesVisible); }, [collisionProxiesVisible]);

  return <canvas ref={canvasRef} className="editor-canvas" aria-label="Level editor viewport" />;
}

class EditorViewportController {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspective = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  private readonly orthographic = new THREE.OrthographicCamera(-25, 25, 25, -25, 0.1, 500);
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private readonly orbit: OrbitControls;
  private readonly transform: TransformControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly records = new Map<string, SceneRecord>();
  private readonly selectionBox = new THREE.BoxHelper(new THREE.Group(), '#f4ec18');
  private readonly observer: ResizeObserver;
  private frame = 0;
  private selectedId: string | null = null;
  private collisionProxiesVisible = true;
  private transformStart: string | null = null;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly callbacks: ViewportCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color('#091116');
    this.scene.fog = new THREE.Fog('#091116', 90, 260);

    this.perspective.position.set(32, 30, 40);
    this.orthographic.position.set(30, 40, 30);
    this.camera = this.perspective;
    this.camera.lookAt(0, 0, -60);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 0, -55);
    this.orbit.enableDamping = true;
    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setTranslationSnap(0.25);
    this.transform.setRotationSnap(Math.PI / 12);
    this.transform.setScaleSnap(0.25);
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', this.onDraggingChanged);
    this.transform.addEventListener('mouseDown', this.onTransformStart);
    this.transform.addEventListener('mouseUp', this.onTransformComplete);

    const hemisphere = new THREE.HemisphereLight('#dffcff', '#18242b', 2.1);
    const sun = new THREE.DirectionalLight('#fff4d6', 3.1);
    sun.position.set(25, 45, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    this.scene.add(hemisphere, sun);
    const grid = new THREE.GridHelper(300, 300, '#08f7ff', '#263940');
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.34;
    this.scene.add(grid);
    this.selectionBox.visible = false;
    this.selectionBox.renderOrder = 20;
    this.scene.add(this.selectionBox);

    canvas.addEventListener('pointerdown', this.pick);
    window.addEventListener('keydown', this.keyboard);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.animate();
  }

  syncDocument(document: LevelDocumentV2): void {
    const liveIds = new Set<string>();
    for (const item of document.collision) {
      liveIds.add(item.id);
      this.syncRecord(item.id, 'collision', item.kind, () => this.createCollision(item), (object) => this.updateCollision(object, item));
    }
    for (const item of document.visuals) {
      liveIds.add(item.id);
      this.syncRecord(item.id, 'visual', `${item.assetId}:${item.materialVariantId ?? ''}`, () => this.createVisual(item), (object) => this.updateVisual(object, item));
    }
    for (const item of document.lights) {
      liveIds.add(item.id);
      this.syncRecord(item.id, 'light', item.kind, () => this.createLight(item), (object) => this.updateLight(object, item));
    }
    for (const item of document.spawns) {
      liveIds.add(item.id);
      this.syncRecord(item.id, 'spawn', item.kind, () => this.createSpawn(item.kind), (object) => {
        object.position.fromArray(item.position);
        object.rotation.set(0, item.rotationY, 0);
      });
    }
    for (const item of document.encounters) {
      liveIds.add(item.id);
      this.syncRecord(item.id, 'encounter', 'encounter', () => this.createEncounter(), (object) => object.position.fromArray(item.checkpoint));
    }
    for (const item of document.offMeshLinks) {
      liveIds.add(item.id);
      this.syncRecord(item.id, 'link', 'link', () => this.createLink(), (object) => this.updateLink(object, item.start, item.end));
    }

    for (const [id, record] of this.records) {
      if (liveIds.has(id)) continue;
      this.removeRecord(record);
      this.records.delete(id);
    }
    this.setSelected(this.selectedId);
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.transform.detach();
    this.selectionBox.visible = false;
    if (!id) return;
    const record = this.records.get(id);
    if (!record || !record.object.visible) return;
    if (record.kind !== 'link') this.transform.attach(record.object);
    this.selectionBox.setFromObject(record.object);
    this.selectionBox.visible = true;
  }

  setCameraMode(mode: CameraMode): void {
    const next = mode === 'perspective' ? this.perspective : this.orthographic;
    if (next === this.camera) return;
    this.camera = next;
    this.camera.lookAt(this.orbit.target);
    (this.orbit as unknown as { object: THREE.Camera }).object = next;
    (this.transform as unknown as { camera: THREE.Camera }).camera = next;
    this.orbit.update();
    this.resize();
  }

  setCollisionProxiesVisible(visible: boolean): void {
    this.collisionProxiesVisible = visible;
    for (const record of this.records.values()) if (record.kind === 'collision') record.object.visible = visible;
    if (this.selectedId && this.records.get(this.selectedId)?.kind === 'collision') this.setSelected(this.selectedId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.canvas.removeEventListener('pointerdown', this.pick);
    window.removeEventListener('keydown', this.keyboard);
    this.transform.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.transform.removeEventListener('mouseDown', this.onTransformStart);
    this.transform.removeEventListener('mouseUp', this.onTransformComplete);
    this.transform.detach();
    this.transform.dispose();
    this.orbit.dispose();
    for (const record of this.records.values()) this.removeRecord(record);
    this.records.clear();
    disposeObject(this.selectionBox);
    this.renderer.dispose();
  }

  private syncRecord(
    id: string,
    kind: EditorObjectKind,
    contentSignature: string,
    create: () => THREE.Object3D,
    update: (object: THREE.Object3D) => void,
  ): void {
    let record = this.records.get(id);
    if (!record || record.kind !== kind || record.contentSignature !== contentSignature) {
      if (record) this.removeRecord(record);
      const object = create();
      object.userData.editorId = id;
      object.userData.editorKind = kind;
      record = { id, kind, object, contentSignature };
      this.records.set(id, record);
      this.scene.add(object);
    }
    update(record.object);
    if (kind === 'collision') record.object.visible = this.collisionProxiesVisible;
  }

  private createCollision(item: LevelDocumentV2['collision'][number]): THREE.Mesh {
    const material = new THREE.MeshStandardMaterial({ color: item.color, roughness: 0.76, transparent: true, opacity: 0.34, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.renderOrder = 4;
    return mesh;
  }

  private updateCollision(object: THREE.Object3D, item: LevelDocumentV2['collision'][number]): void {
    applyTransform(object, item.transform);
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    mesh.material.color.set(item.color);
    mesh.material.opacity = item.collision ? 0.34 : 0.12;
  }

  private createVisual(item: VisualInstance): THREE.Group {
    return createEditorAssetProxy(item.assetId, item.materialVariantId);
  }

  private updateVisual(object: THREE.Object3D, item: VisualInstance): void {
    applyTransform(object, item.transform);
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = item.castShadow;
      child.receiveShadow = item.receiveShadow;
    });
  }

  private createLight(item: LightInstance): THREE.Group {
    const group = new THREE.Group();
    const markerMaterial = new THREE.MeshBasicMaterial({ color: item.color, wireframe: true, toneMapped: false });
    const marker = item.kind === 'spot'
      ? new THREE.Mesh(new THREE.ConeGeometry(0.48, 1.2, 12, 1, true), markerMaterial)
      : new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 8), markerMaterial);
    if (item.kind === 'spot') {
      marker.rotation.x = -Math.PI / 2;
      marker.position.z = -0.55;
    }
    const light = item.kind === 'spot' ? new THREE.SpotLight() : new THREE.PointLight();
    light.userData.editorLight = true;
    group.userData.light = light;
    group.userData.marker = marker;
    group.add(marker, light);
    if (light instanceof THREE.SpotLight) {
      light.target.position.set(0, 0, -2);
      group.add(light.target);
    }
    return group;
  }

  private updateLight(object: THREE.Object3D, item: LightInstance): void {
    applyTransform(object, item.transform);
    const light = object.userData.light as THREE.PointLight | THREE.SpotLight;
    const marker = object.userData.marker as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    light.color.set(item.color);
    light.intensity = item.intensity;
    light.distance = item.range;
    light.castShadow = item.castShadow;
    marker.material.color.set(item.color);
    if (light instanceof THREE.SpotLight) {
      light.angle = item.coneAngle ?? Math.PI / 4;
      light.penumbra = item.penumbra ?? 0.35;
    }
  }

  private createSpawn(kind: LevelDocumentV2['spawns'][number]['kind']): THREE.Mesh {
    const color = kind === 'player' ? '#08f7ff' : kind === 'bot-aggressive' ? '#ff2d55' : '#f4ec18';
    return new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.4, 8), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 }));
  }

  private createEncounter(): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.OctahedronGeometry(0.62),
      new THREE.MeshStandardMaterial({ color: '#f4ec18', emissive: '#8f5f00', emissiveIntensity: 0.65 }),
    );
  }

  private createLink(): THREE.Line {
    return new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#f4ec18' }));
  }

  private updateLink(object: THREE.Object3D, start: Vec3, end: Vec3): void {
    (object as THREE.Line).geometry.setFromPoints([new THREE.Vector3().fromArray(start), new THREE.Vector3().fromArray(end)]);
  }

  private removeRecord(record: SceneRecord): void {
    if (this.transform.object === record.object) this.transform.detach();
    this.scene.remove(record.object);
    disposeObject(record.object);
  }

  private readonly onDraggingChanged = (event: { value: unknown }) => {
    this.orbit.enabled = !event.value;
  };

  private readonly onTransformStart = () => {
    this.transformStart = this.transform.object ? transformSignature(this.transform.object) : null;
  };

  private readonly onTransformComplete = () => {
    const object = this.transform.object;
    const id = object?.userData.editorId as string | undefined;
    const kind = object?.userData.editorKind as EditorObjectKind | undefined;
    if (object && id && kind && this.transformStart !== transformSignature(object)) this.callbacks.commitTransform(id, kind, object);
    this.transformStart = null;
  };

  private readonly pick = (event: PointerEvent) => {
    const controlState = this.transform as unknown as { dragging?: boolean; axis?: string | null };
    if (controlState.dragging || controlState.axis) return;
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const roots = [...this.records.values()].filter((record) => record.object.visible).map((record) => record.object);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    let target: THREE.Object3D | null = hit?.object ?? null;
    while (target && !target.userData.editorId) target = target.parent;
    this.callbacks.select(target ? target.userData.editorId as string : null);
  };

  private readonly keyboard = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (event.code === 'KeyW') this.transform.setMode('translate');
    if (event.code === 'KeyE') this.transform.setMode('rotate');
    if (event.code === 'KeyR') this.transform.setMode('scale');
  };

  private readonly resize = () => {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(width, height, false);
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    const size = 40;
    this.orthographic.left = -size * width / height;
    this.orthographic.right = size * width / height;
    this.orthographic.top = size;
    this.orthographic.bottom = -size;
    this.orthographic.updateProjectionMatrix();
  };

  private readonly animate = () => {
    if (this.disposed) return;
    this.orbit.update();
    if (this.selectionBox.visible) this.selectionBox.update();
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };
}

function applyTransform(object: THREE.Object3D, transform: TransformData): void {
  object.position.fromArray(transform.position);
  object.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2], 'XYZ');
  object.scale.fromArray(transform.scale);
}

function transformFromObject(object: THREE.Object3D): TransformData {
  return {
    position: vec3(object.position),
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: vec3(object.scale),
  };
}

function transformSignature(object: THREE.Object3D): string {
  return `${object.position.toArray().join(',')}|${object.rotation.toArray().slice(0, 3).join(',')}|${object.scale.toArray().join(',')}`;
}

function vec3(vector: THREE.Vector3): Vec3 {
  return vector.toArray() as unknown as Vec3;
}

function disposeObject(object: THREE.Object3D): void {
  const editorDispose = object.userData.editorDispose as (() => void) | undefined;
  if (editorDispose) {
    editorDispose();
    return;
  }
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line)) return;
    geometries.add(child.geometry);
    const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
    childMaterials.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
