import * as THREE from 'three';

/** Disposes resources owned by a cached template. Shared instances must be gone first. */
export function disposeTemplateScene(scene: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();

  scene.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      materials.add(material);
      for (const property of Object.values(material)) {
        if (property instanceof THREE.Texture) textures.add(property);
      }
    }
  });

  for (const skeleton of skeletons) skeleton.dispose();
  for (const texture of textures) {
    const source = texture.source.data as { close?: () => void } | undefined;
    source?.close?.();
    texture.dispose();
  }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

/** Instances share template geometry/materials, but SkeletonUtils gives them private skeletons. */
export function disposeAssetInstance(scene: THREE.Object3D): void {
  const skeletons = new Set<THREE.Skeleton>();
  scene.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  scene.removeFromParent();
  scene.clear();
}

export function once(action: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
}
