import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { verifyAssetPayload } from '../assets/ThreeAssetLoader';
import { palette } from '../palette';
import { surfaceTextureEntries, type SurfaceTextureId } from '../assets/surfaceTextures';

export type CyberMaterialId =
  | 'deck'
  | 'concrete'
  | 'carbon'
  | 'gunmetal'
  | 'ceramic'
  | 'armor'
  | 'armor-red'
  | 'glass'
  | 'cyan-light'
  | 'amber-light'
  | 'yellow-light'
  | 'red-light'
  | 'skin'
  | 'fabric';

/** Shared PBR materials keep the art layer cheap to draw and cheap to dispose. */
export class MaterialLibrary {
  private readonly materials = new Map<CyberMaterialId, THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial>();
  private readonly ownedTextures: THREE.Texture[] = [];
  private readonly surfaceTextures = new Map<SurfaceTextureId, THREE.Texture>();
  private readonly ktx2Loader: KTX2Loader;
  private readonly surfaceTexturesReady: Promise<void>;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer) {
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    this.ktx2Loader = new KTX2Loader().setTranscoderPath('/vendor/three/basis/').detectSupport(renderer);
    const detail = this.createDetailTexture(maxAnisotropy);
    const normal = this.createNormalTexture(maxAnisotropy);
    this.surfaceTexturesReady = this.loadSurfaceTextures(maxAnisotropy);

    this.materials.set('deck', new THREE.MeshStandardMaterial({
      color: '#27313b', metalness: 0.72, roughness: 0.34, map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.22, 0.22),
    }));
    this.materials.set('concrete', new THREE.MeshStandardMaterial({
      color: '#3b444d', metalness: 0.08, roughness: 0.84, map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.42, 0.42),
    }));
    this.materials.set('carbon', new THREE.MeshStandardMaterial({
      color: '#080d13', metalness: 0.38, roughness: 0.3, map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.3, 0.3),
    }));
    this.materials.set('gunmetal', new THREE.MeshStandardMaterial({
      color: '#1d2730', metalness: 0.94, roughness: 0.19, map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.16, 0.16),
    }));
    this.materials.set('ceramic', new THREE.MeshPhysicalMaterial({
      color: '#6d777c', metalness: 0.34, roughness: 0.28, clearcoat: 0.38, clearcoatRoughness: 0.18,
    }));
    this.materials.set('armor', new THREE.MeshPhysicalMaterial({
      color: '#202b36', metalness: 0.62, roughness: 0.27, clearcoat: 0.24, clearcoatRoughness: 0.3,
    }));
    this.materials.set('armor-red', new THREE.MeshPhysicalMaterial({
      color: '#791d31', metalness: 0.6, roughness: 0.28, clearcoat: 0.32, clearcoatRoughness: 0.23,
    }));
    this.materials.set('glass', new THREE.MeshPhysicalMaterial({
      color: '#6de8ff', emissive: '#09677e', emissiveIntensity: 1.5, metalness: 0.12, roughness: 0.04,
      transmission: 0.16, transparent: true, opacity: 0.82, clearcoat: 1,
    }));
    // Modest intensities on purpose. These colours are fully saturated, so they read as
    // neon without being driven hard; at the old 5.2 a strip close to the camera
    // clipped to white, and clipped white carries no colour at all.
    this.materials.set('cyan-light', this.emissive(palette.cyan, 2.4));
    // `amber-light` keeps its id -- shell casings and pooled FX reference it -- but the
    // colour moves onto the palette's yellow, which the 3D layer was missing entirely.
    this.materials.set('amber-light', this.emissive(palette.yellow, 2.2));
    this.materials.set('yellow-light', this.emissive(palette.yellowHot, 2.6));
    this.materials.set('red-light', this.emissive(palette.red, 2.4));
    this.materials.set('skin', new THREE.MeshPhysicalMaterial({
      color: '#9b685b', roughness: 0.64, metalness: 0, sheen: 0.2, sheenColor: new THREE.Color('#d99b87'),
    }));
    this.materials.set('fabric', new THREE.MeshStandardMaterial({
      color: '#111820', roughness: 0.9, metalness: 0.04, map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.58, 0.58),
    }));
  }

  get(id: CyberMaterialId): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial {
    const material = this.materials.get(id);
    if (!material) throw new Error(`Unknown cyber material: ${id}`);
    return material;
  }

  ready(): Promise<void> {
    return this.surfaceTexturesReady;
  }

  variant(base: CyberMaterialId, color: THREE.ColorRepresentation, emissive?: THREE.ColorRepresentation): THREE.Material {
    const material = this.get(base).clone();
    material.color.set(color);
    if (emissive && 'emissive' in material) {
      material.emissive.set(emissive);
      material.emissiveIntensity = 2.5;
    }
    return material;
  }

  /** Clone imported GLB materials per runtime instance and add the shared authored surface sheets. */
  decorateImported(root: THREE.Object3D): THREE.Material[] {
    const created: THREE.Material[] = [];
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const decorated = source.map((material) => {
        if (!(material instanceof THREE.MeshStandardMaterial)) return material;
        const texture = this.surfaceForMaterial(material.name);
        if (!texture) return material;
        const clone = material.clone();
        clone.map = texture;
        clone.needsUpdate = true;
        created.push(clone);
        return clone;
      });
      object.material = Array.isArray(object.material) ? decorated : decorated[0]!;
    });
    return created;
  }

  dispose(): void {
    this.disposed = true;
    this.materials.forEach((material) => material.dispose());
    this.materials.clear();
    this.ownedTextures.forEach((texture) => texture.dispose());
    this.ownedTextures.length = 0;
    this.ktx2Loader.dispose();
  }

  private emissive(color: THREE.ColorRepresentation, intensity: number): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, metalness: 0.3, roughness: 0.22 });
  }

  private async loadSurfaceTextures(anisotropy: number): Promise<void> {
    await Promise.all(Object.entries(surfaceTextureEntries).map(async ([rawId, definition]) => {
      const id = rawId as SurfaceTextureId;
      try {
        const response = await fetch(definition.uri);
        if (!response.ok) throw new Error(`Texture request failed (${response.status}): ${definition.uri}`);
        const data = await response.arrayBuffer();
        await verifyAssetPayload(data, definition.byteLength, definition.hash);
        const texture = await new Promise<THREE.CompressedTexture>((resolve, reject) => this.ktx2Loader.parse(data, resolve, reject));
        if (this.disposed) {
          texture.dispose();
          return;
        }
        texture.name = `cyber-dusk:${id}`;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = Math.min(8, anisotropy);
        this.surfaceTextures.set(id, texture);
        this.ownedTextures.push(texture);
      } catch (error) {
        // The PBR material colors remain a complete diagnostic fallback.
        console.warn(`Cyber-dusk texture ${id} failed integrity/load checks; using material fallback.`, error);
      }
    }));
  }

  private surfaceForMaterial(name: string): THREE.Texture | undefined {
    if (/(skin|glass|lens)/i.test(name)) return undefined;
    if (/(signal|emissive|cyan|red|magenta|amber|route|light)/i.test(name)) return this.surfaceTextures.get('signal');
    if (/(ceramic|concrete|white|porcelain)/i.test(name)) return this.surfaceTextures.get('ceramic');
    if (/(gunmetal|brushed|trim|steel|metal)/i.test(name)) return this.surfaceTextures.get('gunmetal');
    if (/(graphite|carbon|deck|armor|fabric|glove|coat)/i.test(name)) return this.surfaceTextures.get('graphite');
    return undefined;
  }

  private createDetailTexture(anisotropy: number): THREE.DataTexture {
    const size = 64;
    const pixels = new Uint8Array(size * size * 4);
    let seed = 0x8d12f3a7;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        const noise = 112 + ((seed >>> 24) & 15);
        const groove = x % 16 === 0 || y % 16 === 0 ? -18 : 0;
        const index = (y * size + x) * 4;
        pixels[index] = noise + groove;
        pixels[index + 1] = noise + groove;
        pixels[index + 2] = noise + groove;
        pixels[index + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, anisotropy);
    texture.needsUpdate = true;
    this.ownedTextures.push(texture);
    return texture;
  }

  private createNormalTexture(anisotropy: number): THREE.DataTexture {
    const size = 32;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = (y * size + x) * 4;
        const seam = x % 8 === 0 || y % 8 === 0;
        pixels[index] = seam ? 116 : 128;
        pixels[index + 1] = seam ? 140 : 128;
        pixels[index + 2] = 250;
        pixels[index + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(8, 8);
    texture.anisotropy = Math.min(8, anisotropy);
    texture.needsUpdate = true;
    this.ownedTextures.push(texture);
    return texture;
  }
}
