#!/usr/bin/env node

import { mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const blender = process.env.FLOWSTATE_BLENDER ?? path.join(root, '.tooling/blender-4.5.10/Blender.app/Contents/MacOS/Blender');
const transform = path.join(root, 'node_modules/.bin/gltf-transform');

if (!existsSync(blender)) throw new Error(`Blender 4.5 was not found at ${blender}. See tools/art/BLENDER_4_5.md.`);
if (!existsSync(transform)) throw new Error('gltf-transform is not installed. Run npm install.');

run(process.execPath, [path.join(root, 'tools/art/build-surface-textures.mjs')]);
run(blender, ['--background', '--python', path.join(root, 'tools/art/generate_vertical_slice.py')]);

const assets = [
  ['art-src/blender/viewmodels/runner-rifle.blend', 'EXPORT', 'viewmodels/runner-rifle.glb'],
  ['art-src/blender/characters/hunter-ranged.blend', 'EXPORT', 'characters/hunter-ranged.glb'],
  ['art-src/blender/characters/hunter-aggressive.blend', 'EXPORT', 'characters/hunter-aggressive.glb'],
  ['art-src/blender/environment/rooftop-kit.blend', 'ROOFTOP_PLATFORM', 'environment/rooftop-platform.glb'],
  ['art-src/blender/environment/rooftop-kit.blend', 'WALLRUN_PANEL', 'environment/wallrun-panel.glb'],
  ['art-src/blender/environment/rooftop-kit.blend', 'VAULT_BARRIER', 'environment/vault-barrier.glb'],
  ['art-src/blender/environment/rooftop-kit.blend', 'GRAPPLE_ANCHOR', 'environment/grapple-anchor.glb'],
  ['art-src/blender/environment/rooftop-kit.blend', 'ROUTE_SIGN', 'environment/route-sign.glb'],
];

for (const [source, collection, destination] of assets) {
  const publicPath = path.join(root, 'public/assets/art', destination);
  const optimizedPath = path.join(root, 'build/art/optimized', destination);
  await mkdir(path.dirname(publicPath), { recursive: true });
  await mkdir(path.dirname(optimizedPath), { recursive: true });
  run(blender, [
    '--background', path.join(root, source),
    '--python', path.join(root, 'tools/art/export_glb.py'), '--',
    '--collection', collection, '--output', publicPath,
  ]);
  run(transform, ['meshopt', publicPath, optimizedPath, '--level', 'high']);
  await rename(optimizedPath, publicPath);
}

run(process.execPath, [path.join(root, 'tools/art/normalize-viewmodel-clips.mjs')]);
run(process.execPath, [path.join(root, 'tools/art/normalize-animation-rigs.mjs')]);
run(process.execPath, [path.join(root, 'tools/art/sync-three-transcoders.mjs')]);
run(process.execPath, [path.join(root, 'tools/art/sync-asset-metadata.mjs')]);
run(process.execPath, [path.join(root, 'tools/art/sync-surface-texture-metadata.mjs')]);
run(process.execPath, [path.join(root, 'tools/art/validate-assets.mjs')]);
run(process.execPath, [path.join(root, 'tools/art/validate-surface-textures.mjs')]);
run(process.execPath, [path.join(root, 'tools/art/validate-runtime-art-budget.mjs')]);
process.stdout.write('Flow State art build complete.\n');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
