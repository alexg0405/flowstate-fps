import * as THREE from 'three';

/** What a material variant does to a material, resolved once per visual instance. */
export interface VariantAccent {
  accent: THREE.Color | null;
  weathered: boolean;
}

/**
 * Accents for the level's semantic surface ids. `alignedVisual` names a visual's
 * variant after the collision surface it was generated from, so a catalog without an
 * entry for `wall-run` still tints the panel the traversal layer promises.
 */
const semanticAccents: Record<string, string> = {
  'wall-run': '#4defff',
  vault: '#ff3569',
  mantle: '#ff3569',
  'no-traverse': '#ffb547',
};

export function resolveVariantAccent(
  variants: readonly { id: string; accent: string }[],
  variantId?: string,
): VariantAccent {
  if (!variantId || variantId === 'base' || variantId === 'default') return { accent: null, weathered: false };
  const accent = variants.find((variant) => variant.id === variantId)?.accent ?? semanticAccents[variantId];
  return { accent: accent ? new THREE.Color(accent) : null, weathered: variantId === 'weathered' };
}

/**
 * The variant's form of one material, or null when the variant leaves it alone —
 * only the signal trim accents, so a hostile or a barrier reads as a silhouette
 * with a marking rather than a glowing block.
 */
export function accentMaterial(material: THREE.Material, variant: VariantAccent): THREE.Material | null {
  if (!(material instanceof THREE.MeshStandardMaterial)) return null;
  if (!variant.accent && !variant.weathered) return null;
  const shouldAccent = material.emissive.getHex() !== 0 || /(signal|cyan|red|amber|light|route)/i.test(material.name);
  if (!variant.weathered && !shouldAccent) return null;
  const clone = material.clone();
  if (variant.weathered) {
    clone.color.multiplyScalar(0.62);
    clone.roughness = Math.max(0.82, clone.roughness);
    clone.metalness *= 0.55;
  } else if (variant.accent) {
    clone.color.copy(variant.accent);
    clone.emissive.copy(variant.accent);
  }
  return clone;
}

/**
 * Anything that cannot be represented as one geometry drawn at many transforms:
 * skinned meshes carry their own pose, multi-material meshes need one draw per
 * material group anyway, and lines, points and sprites are not meshes at all.
 * Such a visual is drawn whole instead of batched.
 */
export function canBatch(root: THREE.Object3D): boolean {
  let batchable = true;
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh || object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite) batchable = false;
    else if (object instanceof THREE.Mesh && Array.isArray(object.material)) batchable = false;
  });
  return batchable;
}

export interface VisualBatchSource {
  /** A positioned asset instance. Its world matrices are what the batch records. */
  root: THREE.Object3D;
  variant: VariantAccent;
}

export interface VisualBatch {
  geometry: THREE.BufferGeometry;
  /** The instance material the batch's single shared material is derived from. */
  material: THREE.Material;
  variant: VariantAccent;
  castShadow: boolean;
  receiveShadow: boolean;
  matrices: THREE.Matrix4[];
}

/**
 * Collapses positioned asset instances into one batch per distinct appearance.
 *
 * Instances of a catalog asset share the template's buffers — `SkeletonUtils.clone`
 * copies the nodes, not the geometry — so a set of instances that agree on geometry,
 * source material, resolved accent and shadow flags is one draw with a transform per
 * instance. Keying on the *resolved* accent rather than the variant id is what lets
 * `vault` and `mantle`, which resolve to the same colour, share a batch.
 */
export function groupVisualBatches(sources: readonly VisualBatchSource[]): VisualBatch[] {
  const batches = new Map<string, VisualBatch>();
  for (const { root, variant } of sources) {
    root.updateMatrixWorld(true);
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
      const key = [
        object.geometry.uuid,
        object.material.uuid,
        variant.accent?.getHexString() ?? '',
        variant.weathered,
        object.castShadow,
        object.receiveShadow,
      ].join('|');
      let batch = batches.get(key);
      if (!batch) {
        batch = {
          geometry: object.geometry,
          material: object.material,
          variant,
          castShadow: object.castShadow,
          receiveShadow: object.receiveShadow,
          matrices: [],
        };
        batches.set(key, batch);
      }
      batch.matrices.push(object.matrixWorld.clone());
    });
  }
  return [...batches.values()];
}
