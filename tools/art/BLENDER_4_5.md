# Blender 4.5 art contract

Blender 4.5 LTS `.blend` files are the editable source of truth. Runtime files are self-contained GLB 2.0 assets post-processed with Meshopt geometry compression and KTX2/Basis textures. Do not hand-edit exported GLBs.

The repository-local toolchain is pinned to Blender **4.5.10 LTS** at `.tooling/blender-4.5.10/` (ignored by Git). Set `FLOWSTATE_BLENDER` when using the same 4.5.x release from a different location.

KTX-Software **4.4.2** is pinned locally at `.tooling/ktx-4.4.2-local/` (also ignored). Set `FLOWSTATE_TOKTX` when using the same release from another location. The checked-in source atlas and texture build script make the compressed output reproducible without storing PNG intermediates in the runtime tree.

## Repository layout

```text
art-src/blender/viewmodels/runner-rifle.blend
art-src/blender/characters/hunter-ranged.blend
art-src/blender/characters/hunter-aggressive.blend
art-src/blender/environment/rooftop-kit.blend
art-src/textures/cyber-dusk-surface-atlas.png
build/art/raw/                         # ignored intermediary GLBs
build/art/textures/                    # ignored intermediary PNG sheets
public/assets/art/                     # optimized runtime GLBs + KTX2 sheets
```

The curated runtime paths, required nodes and clips, and per-asset budgets live in `src/render/assets/catalog.json`. Changing an ID is a schema migration, not a filename cleanup.

## Coordinates and transforms

- Units are metric with `scale_length = 1.0`; one Blender unit is one meter.
- Blender is Z-up. The exporter converts to glTF/Three Y-up.
- Author characters and forward-facing props toward Blender `-Y`, which imports facing Three `-Z` with this exporter.
- Apply scale on meshes and armatures. Negative scale is forbidden. Rotation and location may remain purposeful.
- Character origin: floor center between the feet. Environment origin: placement pivot on the supporting surface. Viewmodel origin: right-hand grip reference.
- Model visual geometry only. Runtime collision and navigation use separate authored proxy data.

## File and object structure

- Put every runtime object under one collection named `EXPORT`.
- Keep references, high-poly meshes, collision studies, and cameras outside `EXPORT`, or set custom property `no_export = true`.
- Names use lowercase `snake_case`; names must be unique within the file.
- Placement/attachment nodes are Blender Empties named `socket_*`. Required socket names are catalogued.
- Meshes should have clean custom normals, purposeful hard edges, UV0, and UV1 when a lightmap/AO bake requires it.
- Triangulation is an export concern, but check deformation and shading on the triangulated result before delivery.
- Avoid very thin overlapping surfaces, accidental interior faces, and unbounded modifier subdivision.

## Characters and animation

- One deforming armature per character asset; non-deforming control bones have Deform disabled.
- Root/pelvis motion remains in-place. Rapier owns world translation; do not ship gameplay root motion.
- One named Blender Action per catalog clip. Clip names must match exactly, including lowercase and underscores.
- Animation sampling is 30 or 60 fps. Remove redundant keys before export.
- The first frame and final frame of loops must blend without a duplicate held frame.
- Required hunter clips cover idle, run, strafes, attack, hit, death, jump, vault, drop, and land.
- The first-person asset owns arms, rifle, and their shared animation rig. Keep muzzle/ejection/hand sockets stable across revisions.

## Materials and textures

- Use Principled BSDF materials compatible with glTF metallic/roughness PBR.
- Color/emissive textures are sRGB. Normal, roughness, metallic, and occlusion data are non-color.
- Texture dimensions are powers of two and no larger than the catalog budget (currently 2048 px).
- Pack ORM channels when the offline optimizer supports it. Avoid unique materials where a shared palette or vertex color is sufficient.
- Blender exports an uncompressed interchange GLB. The offline post-process produces `EXT_meshopt_compression`; the original surface atlas is split and encoded as mipmapped ETC1S/KTX2 sheets loaded through Three's matching Basis transcoder.

## Export and validation

Regenerate all original sources, export all catalog assets, apply Meshopt, sync the matching Basis decoder, and validate in one command:

```sh
npm run art:build
```

The source generator is deterministic and lives at `tools/art/generate_vertical_slice.py`; its output remains normal editable Blender content.

Rebuild only the generated 1024² KTX2 surface sheets:

```sh
npm run art:textures
```

Export raw GLB:

```sh
blender --background art-src/blender/characters/hunter-ranged.blend \
  --python tools/art/export_glb.py -- \
  --output build/art/raw/characters/hunter-ranged.glb
```

After the project’s glTF optimization step writes `public/assets/art/**`, copy Three's matching Basis transcoder files and validate:

```sh
node tools/art/sync-three-transcoders.mjs
npm run art:sync-metadata
npm run art:validate
```

Metadata synchronization is deterministic and runs automatically during `npm run art:build`. It records each final GLB and KTX2 sheet's SHA-256 hash and transfer size, plus scaled local bounds, accessor-based CPU/GPU resident-memory estimates, and LOD file metadata. CI validation rejects any runtime binary whose bytes no longer match its catalog; `npm run art:sync-metadata -- --check` performs the same freshness check without writing.

The build normalizes the viewmodel clip contract and rigid animated hierarchy after Meshopt, so legacy exports remain compatible while the Blender source preserves material-and-bone batches. During initial source work, `node tools/art/validate-assets.mjs --allow-missing` validates catalog structure while reporting unexported assets as warnings. Strict validation is the release/CI gate. It checks GLB structure, budgets, required extensions, socket names, clip names, animated mesh/socket ancestry, distinct measurable motion, self-containment, bone counts, KTX2 metadata, and the aggregate 25 MB initial payload budget.

Procedural fallbacks in `src/render/assets/fallbacks.ts` deliberately keep the game and editor usable before binary art lands. They are diagnostics, not shippable replacements; loaded instances identify themselves with `userData.isAssetFallback` and `userData.assetSource`.
