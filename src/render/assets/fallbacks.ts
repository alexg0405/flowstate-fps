import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { AssetTemplate, FallbackAssetId } from './types';
import { disposeTemplateScene, once } from './resourceLifecycle';

const CLIPS: Partial<Record<FallbackAssetId, readonly string[]>> = {
  'viewmodel-rifle': [
    'vm_equip', 'vm_idle', 'vm_sprint', 'vm_fire_01', 'vm_fire_02', 'vm_ads_in', 'vm_ads_out',
    'vm_reload_tactical', 'vm_reload_empty', 'vm_melee', 'vm_grapple_cast', 'vm_grapple_hold', 'vm_grapple_release',
  ],
  'hunter-ranged': [
    'hunter_idle', 'hunter_run', 'hunter_strafe_l', 'hunter_strafe_r', 'hunter_fire', 'hunter_hit',
    'hunter_death', 'hunter_jump', 'hunter_vault', 'hunter_drop', 'hunter_land',
  ],
  'hunter-aggressive': [
    'hunter_idle', 'hunter_run', 'hunter_strafe_l', 'hunter_strafe_r', 'hunter_melee', 'hunter_hit',
    'hunter_death', 'hunter_jump', 'hunter_vault', 'hunter_drop', 'hunter_land',
  ],
};

export function createFallbackAsset(id: FallbackAssetId): AssetTemplate {
  const scene = id === 'viewmodel-rifle'
    ? createViewmodelRifle()
    : id === 'hunter-ranged'
      ? createHunter(false)
      : id === 'hunter-aggressive'
        ? createHunter(true)
        : createEnvironmentFallback(id);
  scene.userData.fallbackAssetId = id;
  scene.userData.isAssetFallback = true;
  const animations = (CLIPS[id] ?? []).map((name) => new THREE.AnimationClip(name, 0.1, []));
  return {
    scene,
    animations,
    source: 'fallback',
    dispose: once(() => disposeTemplateScene(scene)),
  };
}

function createViewmodelRifle(): THREE.Group {
  const root = namedGroup('viewmodel_runner_rifle');
  const white = standard('#e9ebe8', 0.34, 0.15);
  const graphite = standard('#17232d', 0.6, 0.42);
  const rubber = standard('#071015', 0.92, 0.02);
  const accent = standard('#ee2843', 0.38, 0.16, '#8e071c');
  const receiver = roundedBox('receiver', [0.25, 0.22, 0.82], white, 0.035);
  receiver.position.z = -0.4;
  const upper = roundedBox('upper_receiver', [0.19, 0.14, 0.58], graphite, 0.025);
  upper.position.set(0, 0.13, -0.47);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.044, 0.62, 18), graphite);
  barrel.name = 'barrel';
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -1.08);
  const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.35, 18), white);
  shroud.name = 'barrel_shroud';
  shroud.rotation.x = Math.PI / 2;
  shroud.position.set(0, 0.02, -0.78);
  const magazine = roundedBox('magazine', [0.15, 0.36, 0.24], rubber, 0.025);
  magazine.position.set(0, -0.27, -0.3);
  magazine.rotation.x = -0.18;
  const grip = roundedBox('grip', [0.13, 0.34, 0.17], graphite, 0.03);
  grip.position.set(0, -0.25, 0.05);
  grip.rotation.x = -0.2;
  const rail = roundedBox('accent_rail', [0.265, 0.035, 0.48], accent, 0.012);
  rail.position.set(0, 0.19, -0.36);
  const sight = roundedBox('sight', [0.1, 0.12, 0.17], rubber, 0.018);
  sight.position.set(0, 0.25, -0.38);
  root.add(receiver, upper, barrel, shroud, magazine, grip, rail, sight);
  root.add(socket('socket_muzzle', [0, 0.02, -1.4]));
  root.add(socket('socket_eject', [0.14, 0.1, -0.34]));
  root.add(socket('socket_hand_l', [-0.13, -0.06, -0.7]));
  root.add(socket('socket_hand_r', [0, -0.2, 0.05]));
  root.add(socket('socket_grapple_emitter', [-0.13, 0.03, -0.82]));
  return root;
}

function createHunter(aggressive: boolean): THREE.Group {
  const root = namedGroup(aggressive ? 'hunter_aggressive' : 'hunter_ranged');
  const suit = standard(aggressive ? '#6e1528' : '#153b54', 0.62, 0.12);
  const coat = standard(aggressive ? '#e72f50' : '#2ca6aa', 0.54, 0.08);
  const dark = standard('#101b24', 0.75, 0.12);
  const skin = standard('#dca080', 0.72, 0);
  const metal = standard('#cfdadd', 0.32, 0.72);

  const pelvis = roundedBox('pelvis', [0.44, 0.28, 0.28], suit, 0.08);
  pelvis.position.y = 1.02;
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.46, 8, 16), suit);
  chest.name = 'chest';
  chest.scale.z = 0.62;
  chest.position.y = 1.48;
  const coatPanel = roundedBox('coat_panel', [0.64, 0.8, 0.08], coat, 0.06);
  coatPanel.position.set(0, 1.18, 0.19);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 24, 16), skin);
  head.name = 'head';
  head.scale.set(0.86, 1.06, 0.92);
  head.position.set(0, 2.1, 0);
  const visor = roundedBox('visor', [0.38, 0.09, 0.04], standard('#dffffc', 0.2, 0.42, '#42d8e1'), 0.018);
  visor.position.set(0, 2.13, -0.24);
  root.add(pelvis, chest, coatPanel, head, visor);
  root.add(limb('arm_l', [-0.39, 1.58, 0], coat));
  root.add(limb('arm_r', [0.39, 1.58, 0], coat));
  root.add(limb('leg_l', [-0.18, 0.9, 0], suit, 0.6));
  root.add(limb('leg_r', [0.18, 0.9, 0], suit, 0.6));

  const weapon = aggressive
    ? roundedBox('hunter_blade', [0.07, 0.08, 1.15], metal, 0.02)
    : roundedBox('hunter_rifle', [0.11, 0.12, 0.9], dark, 0.025);
  weapon.position.set(0.43, 1.24, -0.28);
  weapon.rotation.x = aggressive ? Math.PI / 2 : 0.18;
  root.add(weapon, socket('socket_weapon', [0.43, 1.34, -0.05]), socket('socket_head', [0, 2.12, 0]));
  if (!aggressive) root.add(socket('socket_muzzle', [0.43, 1.15, -0.78]));
  return root;
}

function createEnvironmentFallback(id: FallbackAssetId): THREE.Group {
  const root = namedGroup(id.replaceAll('-', '_'));
  const concrete = standard('#e5e8e4', 0.86, 0.02);
  const cyan = standard('#22b7c2', 0.46, 0.08, '#075e69');
  const red = standard('#ed2945', 0.5, 0.08, '#7a0718');
  const dark = standard('#17242d', 0.72, 0.2);
  if (id === 'environment-platform') {
    const slab = roundedBox('platform', [4, 0.42, 4], concrete, 0.12);
    const route = roundedBox('route_mark', [0.28, 0.025, 3], red, 0.008);
    route.position.set(-1.35, 0.23, 0);
    root.add(slab, route);
  } else if (id === 'environment-wallrun-panel') {
    const panel = roundedBox('wallrun_panel', [4, 2.8, 0.24], concrete, 0.1);
    const stripe = roundedBox('traversal_stripe', [3.4, 0.18, 0.03], cyan, 0.02);
    stripe.position.z = -0.14;
    root.add(panel, stripe);
  } else if (id === 'environment-vault-barrier') {
    const barrier = roundedBox('vault_barrier', [2.4, 1.05, 0.5], red, 0.12);
    barrier.position.y = 0.525;
    root.add(barrier);
  } else if (id === 'environment-grapple-anchor') {
    const anchor = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 2), red);
    anchor.name = 'grapple_anchor';
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.07, 10, 32), dark);
    ring.name = 'anchor_ring';
    root.add(anchor, ring, socket('socket_grapple', [0, 0, 0]));
  } else {
    const sign = roundedBox('route_sign', [2.8, 0.8, 0.08], concrete, 0.06);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.62, 3), red);
    arrow.name = 'route_arrow';
    arrow.rotation.z = -Math.PI / 2;
    arrow.position.set(0.82, 0, -0.08);
    root.add(sign, arrow);
  }
  return root;
}

function standard(
  color: THREE.ColorRepresentation,
  roughness: number,
  metalness: number,
  emissive: THREE.ColorRepresentation = '#000000',
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    emissive,
    emissiveIntensity: emissive === '#000000' ? 0 : 0.35,
  });
}

function roundedBox(
  name: string,
  size: readonly [number, number, number],
  material: THREE.Material,
  radius: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(size[0], size[1], size[2], 4, radius), material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function limb(
  name: string,
  position: readonly [number, number, number],
  material: THREE.Material,
  length = 0.48,
): THREE.Group {
  const pivot = namedGroup(name);
  pivot.position.fromArray(position);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, length, 8, 14), material);
  mesh.name = `${name}_mesh`;
  mesh.position.y = -(length * 0.5 + 0.09);
  mesh.castShadow = true;
  pivot.add(mesh);
  return pivot;
}

function socket(name: string, position: readonly [number, number, number]): THREE.Object3D {
  const object = new THREE.Object3D();
  object.name = name;
  object.position.fromArray(position);
  object.userData.isSocket = true;
  return object;
}

function namedGroup(name: string): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  return group;
}
