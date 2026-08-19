import * as THREE from 'three';
import { assetCatalog, assetEntries } from '../render/assets/catalog';
import { createFallbackAsset } from '../render/assets/fallbacks';
import type { AssetDefinition, AssetId } from '../render/assets/types';

export interface EditorMaterialVariant {
  id: string;
  label: string;
  accent: string;
}

export interface EditorAssetItem {
  id: AssetId;
  label: string;
  category: string;
  definition: AssetDefinition;
  variants: readonly EditorMaterialVariant[];
}

const BASE_VARIANT: EditorMaterialVariant = { id: 'base', label: 'Base', accent: '#08f7ff' };
export const editorSemanticVariants: readonly EditorMaterialVariant[] = [
  { id: 'default', label: 'Surface · Default', accent: '#08f7ff' },
  { id: 'wall-run', label: 'Surface · Wall run', accent: '#4defff' },
  { id: 'vault', label: 'Surface · Vault', accent: '#ff3569' },
  { id: 'mantle', label: 'Surface · Mantle', accent: '#ff3569' },
  { id: 'no-traverse', label: 'Surface · No traverse', accent: '#ffb547' },
];

export const editorAssetCatalogVersion = `core-v${assetCatalog.schemaVersion}`;

export const editorAssetItems: readonly EditorAssetItem[] = Object.entries(assetEntries)
  .filter(([, definition]) => definition.kind === 'environment')
  .map(([id, definition]) => ({
    id: id as AssetId,
    label: labelFromId(id),
    category: categoryFor(definition),
    definition,
    variants: mergeVariants(definition.variants, editorSemanticVariants),
  }));

export const editorAssetCategories = ['All', ...new Set(editorAssetItems.map((item) => item.category))];

export function getEditorAssetItem(assetId: string): EditorAssetItem | undefined {
  return editorAssetItems.find((item) => item.id === assetId);
}

export function createEditorAssetProxy(assetId: string, materialVariantId?: string): THREE.Group {
  const item = getEditorAssetItem(assetId);
  if (!item) {
    const unknown = new THREE.Group();
    unknown.name = `editor-asset:${assetId}`;
    unknown.add(new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.5, 1.5),
      new THREE.MeshStandardMaterial({ color: '#26343b', roughness: 0.67, metalness: 0.42 }),
    ));
    return unknown;
  }

  const template = createFallbackAsset(item.definition.fallback);
  const group = template.scene;
  group.name = `editor-asset:${assetId}`;
  group.userData.editorDispose = template.dispose;
  const accent = item?.variants.find((variant) => variant.id === materialVariantId)?.accent ?? BASE_VARIANT.accent;
  if (materialVariantId && materialVariantId !== 'base' && materialVariantId !== 'default') applyVariant(group, materialVariantId, accent);

  return group;
}

function applyVariant(group: THREE.Group, materialVariantId: string, accent: string): void {
  const accentColor = new THREE.Color(accent);
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (materialVariantId === 'weathered') {
        material.color.multiplyScalar(0.62);
        material.roughness = Math.max(0.82, material.roughness);
        material.metalness *= 0.55;
      } else if (material.emissive.getHex() !== 0 || /(route|stripe|barrier|anchor|arrow)/i.test(child.name)) {
        material.color.copy(accentColor);
        material.emissive.copy(accentColor);
      }
    }
  });
}

function categoryFor(definition: AssetDefinition): string {
  if (definition.tags.includes('wayfinding')) return 'Wayfinding';
  if (definition.tags.includes('traversal')) return 'Traversal';
  return 'Architecture';
}

function mergeVariants(...groups: readonly (readonly EditorMaterialVariant[])[]): readonly EditorMaterialVariant[] {
  const variants = new Map<string, EditorMaterialVariant>();
  for (const group of groups) for (const variant of group) variants.set(variant.id, variant);
  return [...variants.values()];
}

function labelFromId(id: string): string {
  return id.split('.').at(-1)!.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}
