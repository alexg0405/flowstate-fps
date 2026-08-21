import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { verifyAssetPayload } from '../assets/ThreeAssetLoader';
import { palette } from '../palette';
import { surfaceTextureEntries, type SurfaceTextureId } from '../assets/surfaceTextures';
import { bandProfiles, bandTexture, cangianteGradient, liftAlbedo, rimLight, type BandProfileId } from './toonBands';
import { FACE_BLEND, paintByFacing } from './facePaint';

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

/**
 * Every surface in the game, and the one place the shading model is decided.
 *
 * These were `MeshStandardMaterial` and `MeshPhysicalMaterial` -- metalness from 0.08 to
 * 0.94, roughness from 0.04 to 0.9, normal maps, clearcoat and a PMREM environment probe.
 * That is a photographic shading model, and no amount of grading downstream of it produces
 * a face that is teal because the silhouette is better that way.
 *
 * They are now banded toon materials with a **coloured** ramp: how many steps the light is
 * divided into and what hue a surface turns as it leaves the light, both authored per
 * material and both carried by one generated texture. See `toonBands`.
 *
 * Two things are given up deliberately. There is no specular response and no environment
 * reflection, because both are the renderer describing a physical surface and this look
 * describes a plane. And clearcoat, sheen and transmission go with them -- glass is a
 * bright flat colour that happens to be see-through rather than a refracting solid. What
 * is bought, besides the look, is a materially cheaper shader on the phone profile.
 */
export class MaterialLibrary {
  private readonly materials = new Map<CyberMaterialId, THREE.MeshToonMaterial>();
  private readonly ownedTextures: THREE.Texture[] = [];
  private readonly surfaceTextures = new Map<SurfaceTextureId, THREE.Texture>();
  private readonly gradients = new Map<BandProfileId, THREE.DataTexture>();
  private readonly ktx2Loader: KTX2Loader;
  private readonly surfaceTexturesReady: Promise<void>;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer) {
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    this.ktx2Loader = new KTX2Loader().setTranscoderPath('/vendor/three/basis/').detectSupport(renderer);
    const detail = this.createDetailTexture(maxAnisotropy);
    const normal = this.createNormalTexture(maxAnisotropy);
    this.surfaceTexturesReady = this.loadSurfaceTextures(maxAnisotropy);

    this.materials.set('deck', this.toon('architecture', {
      color: '#2b3743', map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.22, 0.22),
    }));
    this.materials.set('concrete', this.toon('architecture', {
      color: '#3b4550', map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.42, 0.42),
    }));
    this.materials.set('carbon', this.toon('architecture', {
      color: '#0b1218', map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.3, 0.3),
    }));
    this.materials.set('gunmetal', this.toon('prop', {
      color: '#2b3945', map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.16, 0.16),
    }));
    this.materials.set('ceramic', this.toon('character', { color: '#8d979c' }));
    this.materials.set('armor', this.toon('character', { color: '#2b3846' }));
    this.materials.set('armor-red', this.toon('character', { color: '#8d2038' }));
    this.materials.set('glass', this.toon('glass', {
      color: '#6de8ff', emissive: '#09677e', emissiveIntensity: 1.5, transparent: true, opacity: 0.82,
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
    this.materials.set('skin', this.toon('skin', { color: '#a97361' }));
    this.materials.set('fabric', this.toon('prop', {
      color: '#161f28', map: detail, normalMap: normal, normalScale: new THREE.Vector2(0.58, 0.58),
    }));
  }

  get(id: CyberMaterialId): THREE.MeshToonMaterial {
    const material = this.materials.get(id);
    if (!material) throw new Error(`Unknown cyber material: ${id}`);
    return material;
  }

  /**
   * A banded material of the caller's own, on the shared ramp for its profile. For the
   * handful of surfaces a presenter builds itself -- a shield plate, a tower's glow --
   * which still have to shade in the same steps as everything around them.
   */
  build(profile: BandProfileId, parameters: THREE.MeshToonMaterialParameters): THREE.MeshToonMaterial {
    return this.toon(profile, parameters);
  }

  /**
   * One banded material. The gradient is shared per profile rather than per material --
   * there are seven ramps in the game and forty-odd materials, and a texture per material
   * would be forty uploads of the same 64 texels.
   */
  private toon(profile: BandProfileId, parameters: THREE.MeshToonMaterialParameters): THREE.MeshToonMaterial {
    const material = new THREE.MeshToonMaterial({ ...parameters, gradientMap: this.gradient(profile) });
    applyGraphicShading(material, profile);
    return material;
  }

  /** The ramp for a profile, built once. */
  private gradient(profile: BandProfileId): THREE.DataTexture {
    const existing = this.gradients.get(profile);
    if (existing) return existing;
    const size = 64;
    const texture = new THREE.DataTexture(bandTexture(bandProfiles[profile], size), size, 1, THREE.RGBAFormat);
    texture.name = `toon-band:${profile}`;
    // Linear rather than nearest: the softness of a band edge is authored in the ramp
    // itself, so the sampler must not add a second, unauthored hardness on top of it.
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.gradients.set(profile, texture);
    this.ownedTextures.push(texture);
    return texture;
  }

  /**
   * One imported PBR material as a banded one.
   *
   * The authored GLBs arrive as `MeshStandardMaterial` and there is no pipeline available
   * to re-author them -- running the art build is what shipped visibly broken characters
   * once. So the conversion happens here, at load, which is also the only place that sees
   * every imported material exactly once.
   *
   * The profile is the caller's, because the same function decorates a building and a
   * hunter and those want different band counts, with three names overriding it: skin,
   * glass and anything the palette treats as signal.
   */
  /**
   * Paints a geometry's faces by which way they point, once.
   *
   * Idempotent by a flag on the geometry, because the non-batched path decorates a scene
   * per instance and would otherwise rebuild the same attribute for every copy of the same
   * wall. Returns whether the geometry now carries colours, so the material can be told to
   * read them -- a material with `vertexColors` on and no attribute to read renders black.
   */
  paintFaces(geometry: THREE.BufferGeometry, hardness: number = FACE_BLEND.authored): boolean {
    if (geometry.userData.facePainted) return true;
    const normals = geometry.getAttribute('normal');
    if (!normals) return false;
    // Read through the attribute's own accessors rather than off its backing array. An
    // imported GLB's normals are routinely interleaved with its other attributes and
    // routinely stored as normalised integers, so `.array` is neither the right length
    // nor the right units -- which produced a colour attribute of the wrong count and an
    // "offset is out of bounds" the moment `BatchedMesh` tried to copy it.
    const flattened = new Float32Array(normals.count * 3);
    for (let index = 0; index < normals.count; index += 1) {
      flattened[index * 3] = normals.getX(index);
      flattened[index * 3 + 1] = normals.getY(index);
      flattened[index * 3 + 2] = normals.getZ(index);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(paintByFacing(flattened, hardness), 3));
    geometry.userData.facePainted = true;
    return true;
  }

  toonify(source: THREE.Material, profile: BandProfileId, painted = false): THREE.MeshToonMaterial {
    const standard = source as THREE.MeshStandardMaterial;
    const resolved = profileFor(source.name, profile);
    const material = new THREE.MeshToonMaterial({
      name: source.name,
      color: figureColour(standard.color, resolved),
      map: standard.map ?? null,
      normalMap: standard.normalMap ?? null,
      normalScale: standard.normalScale?.clone(),
      alphaMap: standard.alphaMap ?? null,
      emissive: standard.emissive?.clone() ?? new THREE.Color(0x000000),
      emissiveMap: standard.emissiveMap ?? null,
      emissiveIntensity: standard.emissiveIntensity ?? 1,
      transparent: source.transparent,
      opacity: source.opacity,
      alphaTest: source.alphaTest,
      side: source.side,
      depthWrite: source.depthWrite,
      gradientMap: this.gradient(resolved),
      vertexColors: painted,
    });
    applyGraphicShading(material, resolved);
    return material;
  }

  ready(): Promise<void> {
    return this.surfaceTexturesReady;
  }

  variant(base: CyberMaterialId, color: THREE.ColorRepresentation, emissive?: THREE.ColorRepresentation): THREE.Material {
    const material = this.get(base).clone();
    rebindGraphicShading(material);
    material.color.set(color);
    if (emissive && 'emissive' in material) {
      material.emissive.set(emissive);
      material.emissiveIntensity = 2.5;
    }
    return material;
  }

  /**
   * Rebuild an imported GLB's materials as banded ones, with the shared authored surface
   * sheets attached. `profile` is how many steps this kind of thing shades in.
   */
  decorateImported(root: THREE.Object3D, profile: BandProfileId = 'prop'): THREE.Material[] {
    const created: THREE.Material[] = [];
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      // The route's own masses take the face treatment; a figure does not. Painting a
      // hunter by facing would fight the five bands it shades in and flatten the one
      // thing in the frame that has to hold its volume.
      const painted = profile === 'architecture' && this.paintFaces(object.geometry);
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const decorated = source.map((material) => {
        const clone = this.decorateMaterial(material, profile, painted);
        if (clone !== material) created.push(clone);
        return clone;
      });
      object.material = Array.isArray(object.material) ? decorated : decorated[0]!;
    });
    return created;
  }

  /**
   * One imported material, banded and carrying its surface sheet. Split out of
   * `decorateImported` so batched geometry can decorate once per batch rather than once
   * per instance.
   */
  decorateMaterial(material: THREE.Material, profile: BandProfileId = 'prop', painted = false): THREE.Material {
    if (!(material instanceof THREE.MeshStandardMaterial)) return material;
    const converted = this.toonify(material, profile, painted);
    const texture = this.surfaceForMaterial(material.name);
    if (texture) converted.map = texture;
    converted.needsUpdate = true;
    return converted;
  }

  dispose(): void {
    this.disposed = true;
    this.materials.forEach((material) => material.dispose());
    this.materials.clear();
    this.gradients.clear();
    this.ownedTextures.forEach((texture) => texture.dispose());
    this.ownedTextures.length = 0;
    this.ktx2Loader.dispose();
  }

  private emissive(color: THREE.ColorRepresentation, intensity: number): THREE.MeshToonMaterial {
    return this.toon('emissive', { color, emissive: color, emissiveIntensity: intensity });
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

/** An imported albedo, raised to its profile's floor. See `BandProfile.albedoFloor`. */
function figureColour(source: THREE.Color | undefined, profile: BandProfileId): THREE.Color {
  if (!source) return new THREE.Color('#ffffff');
  const lifted = liftAlbedo([source.r, source.g, source.b], bandProfiles[profile].albedoFloor);
  return new THREE.Color(lifted[0], lifted[1], lifted[2]);
}

/**
 * Which ramp a named imported material shades on, when the name says something the
 * caller's blanket profile does not. Three cases only, and all three are ones where the
 * wrong band count is immediately visible: a face, a window, and a lit sign.
 */
function profileFor(name: string, fallback: BandProfileId): BandProfileId {
  if (/(skin|face|flesh)/i.test(name)) return 'skin';
  if (/(glass|lens|visor|window)/i.test(name)) return 'glass';
  if (/(signal|emissive|neon|light|glow)/i.test(name)) return 'emissive';
  return fallback;
}

/**
 * The two shader edits this look needs on top of a stock toon material: a ramp read in
 * colour rather than in grey, and an edge light for the things that have to stay legible
 * against a world of flat masses.
 *
 * `three.js` samples a gradient map's red channel and broadcasts it, so without the first
 * edit every shadow hue in `bandProfiles` would be silently flattened to a value. Both
 * substitutions are asserted rather than assumed, because `onBeforeCompile` runs before
 * includes are resolved and a library upgrade that moved either target would otherwise
 * fail completely silently -- the only symptom being that the game looked slightly worse.
 */
export function applyGraphicShading(material: THREE.MeshToonMaterial, profile: BandProfileId): void {
  const band = bandProfiles[profile];
  // Recorded on the material so a clone can find its way back to the same profile. See
  // `rebindGraphicShading` for why that is not a nicety.
  material.userData.bandProfile = profile;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.flowRimColour = { value: new THREE.Color(...band.rimColour) };
    shader.uniforms.flowRimStrength = { value: band.rim };
    for (const [label, edit] of [
      ['gradient ramp', cangianteGradient],
      ['rim uniforms', rimLight.declare],
      ['rim term', rimLight.apply],
    ] as const) {
      if (!shader.fragmentShader.includes(edit.find)) {
        console.warn(`Toon shader edit "${label}" found no target; the frame will render without it.`);
        continue;
      }
      shader.fragmentShader = shader.fragmentShader.replace(edit.find, edit.replace);
    }
  };
  // Every patched material compiles the same source and differs only in its uniforms, so
  // one key covers them all -- but it has to differ from the unpatched default, or three
  // would hand a patched material a stale program built without any of this.
  material.customProgramCacheKey = () => 'flowstate-graphic-shading';
}

/**
 * Re-applies the shading edits to a cloned material.
 *
 * `Material.copy` does not carry `onBeforeCompile` or `customProgramCacheKey` -- they are
 * own properties assigned per instance, and the copy list does not include them -- so a
 * clone silently reverts to a stock toon material. The symptom is specific and was
 * measured: the world took the banded, rim-lit treatment and the hostiles did not,
 * because hostiles clone their materials per instance to fade a body out on death. Every
 * site in the renderer that clones a library material calls this.
 */
export function rebindGraphicShading(material: THREE.Material): THREE.Material {
  const profile = material.userData?.bandProfile as BandProfileId | undefined;
  if (profile && material instanceof THREE.MeshToonMaterial) applyGraphicShading(material, profile);
  return material;
}
