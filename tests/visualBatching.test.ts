import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  accentMaterial,
  canBatch,
  groupVisualBatches,
  resolveVariantAccent,
} from '../src/render/presentation/visualBatching';

/**
 * One catalog asset instance: a shared geometry and a shared material per mesh, the
 * way `SkeletonUtils.clone` hands them over — the nodes are per instance, the buffers
 * are not, which is the whole reason a group of instances collapses into one draw.
 */
function instance(
  parts: readonly { geometry: THREE.BufferGeometry; material: THREE.Material }[],
  position: readonly [number, number, number],
  { castShadow = true, receiveShadow = true } = {},
): THREE.Object3D {
  const root = new THREE.Group();
  root.position.set(...position);
  for (const part of parts) {
    const mesh = new THREE.Mesh(part.geometry, part.material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    root.add(mesh);
  }
  return root;
}

const deck = () => new THREE.MeshStandardMaterial({ name: 'roof_deck' });
const signal = () => new THREE.MeshStandardMaterial({ name: 'roof_cyan', emissive: '#08f7ff' });

describe('material variants', () => {
  it('resolves the catalog accent ahead of the semantic surface accent', () => {
    const variant = resolveVariantAccent([{ id: 'wall-run', accent: '#123456' }], 'wall-run');
    expect(variant.accent?.getHexString()).toBe('123456');
    expect(resolveVariantAccent([], 'wall-run').accent?.getHexString()).toBe('4defff');
  });

  it('treats the base and default variants as no change at all', () => {
    for (const id of [undefined, 'base', 'default']) {
      const variant = resolveVariantAccent([{ id: 'default', accent: '#ff0000' }], id);
      expect(variant).toEqual({ accent: null, weathered: false });
    }
  });

  it('accents the signal trim and leaves the structure alone', () => {
    const variant = resolveVariantAccent([], 'no-traverse');
    expect(accentMaterial(deck(), variant)).toBeNull();
    const accented = accentMaterial(signal(), variant) as THREE.MeshStandardMaterial;
    expect(accented.color.getHexString()).toBe('ffb547');
    expect(accented.emissive.getHexString()).toBe('ffb547');
  });

  it('darkens everything for the weathered variant, trim or not', () => {
    const variant = resolveVariantAccent([], 'weathered');
    const source = new THREE.MeshStandardMaterial({ name: 'roof_deck', color: '#808080', roughness: 0.3, metalness: 0.8 });
    const weathered = accentMaterial(source, variant) as THREE.MeshStandardMaterial;
    expect(weathered.roughness).toBeCloseTo(0.82, 5);
    expect(weathered.metalness).toBeCloseTo(0.44, 5);
    expect(weathered.color.r).toBeLessThan(source.color.r);
  });
});

describe('batchability', () => {
  it('rejects what cannot be drawn as one geometry at many transforms', () => {
    const geometry = new THREE.BoxGeometry();
    expect(canBatch(instance([{ geometry, material: deck() }], [0, 0, 0]))).toBe(true);

    const multiMaterial = new THREE.Group();
    multiMaterial.add(new THREE.Mesh(geometry, [deck(), signal()]));
    expect(canBatch(multiMaterial)).toBe(false);

    const skinned = new THREE.Group();
    skinned.add(new THREE.SkinnedMesh(geometry, deck()));
    expect(canBatch(skinned)).toBe(false);

    const line = new THREE.Group();
    line.add(new THREE.Line(geometry, new THREE.LineBasicMaterial()));
    expect(canBatch(line)).toBe(false);
  });
});

describe('visual batching', () => {
  const none = { accent: null, weathered: false };

  it('collapses instances of one asset into a batch per mesh, keeping world transforms', () => {
    const parts = [
      { geometry: new THREE.BoxGeometry(), material: deck() },
      { geometry: new THREE.BoxGeometry(2, 2, 2), material: signal() },
    ];
    const batches = groupVisualBatches([
      { root: instance(parts, [0, 0, 0]), variant: none },
      { root: instance(parts, [4, 0, -8]), variant: none },
      { root: instance(parts, [-3, 1, -20]), variant: none },
    ]);

    expect(batches).toHaveLength(2);
    for (const batch of batches) expect(batch.matrices).toHaveLength(3);
    const positions = batches[0].matrices.map((matrix) => new THREE.Vector3().setFromMatrixPosition(matrix).toArray());
    expect(positions).toEqual([[0, 0, 0], [4, 0, -8], [-3, 1, -20]]);
  });

  it('keeps the instance transform, not just its parent, in the batch matrix', () => {
    const geometry = new THREE.BoxGeometry();
    const root = new THREE.Group();
    root.position.set(0, 3, -27);
    const mesh = new THREE.Mesh(geometry, deck());
    mesh.position.set(0, 0.5, 0);
    root.add(mesh);

    const [batch] = groupVisualBatches([{ root, variant: none }]);
    expect(new THREE.Vector3().setFromMatrixPosition(batch.matrices[0]).toArray()).toEqual([0, 3.5, -27]);
  });

  it('splits batches that would not look the same', () => {
    const geometry = new THREE.BoxGeometry();
    const material = signal();
    const wallRun = resolveVariantAccent([], 'wall-run');
    const anchor = resolveVariantAccent([], 'no-traverse');
    const batches = groupVisualBatches([
      { root: instance([{ geometry, material }], [0, 0, 0]), variant: wallRun },
      { root: instance([{ geometry, material }], [1, 0, 0]), variant: anchor },
      { root: instance([{ geometry, material }], [2, 0, 0], { castShadow: false }), variant: wallRun },
    ]);
    expect(batches).toHaveLength(3);
  });

  it('shares a batch between variants that resolve to the same accent', () => {
    // `vault` and `mantle` are different traversal rules and the same paint, so they
    // are one draw. Keying on the variant id instead would have made them two.
    const geometry = new THREE.BoxGeometry();
    const material = signal();
    const batches = groupVisualBatches([
      { root: instance([{ geometry, material }], [0, 0, 0]), variant: resolveVariantAccent([], 'vault') },
      { root: instance([{ geometry, material }], [6, 0, 0]), variant: resolveVariantAccent([], 'mantle') },
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0].matrices).toHaveLength(2);
  });

  it('does not merge different assets that happen to share a material', () => {
    const material = deck();
    const batches = groupVisualBatches([
      { root: instance([{ geometry: new THREE.BoxGeometry(), material }], [0, 0, 0]), variant: none },
      { root: instance([{ geometry: new THREE.BoxGeometry(3, 1, 1), material }], [5, 0, 0]), variant: none },
    ]);
    expect(batches).toHaveLength(2);
  });
});
