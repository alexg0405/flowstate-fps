#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = JSON.parse(await readFile(path.join(root, 'src/render/assets/catalog.json'), 'utf8'));
const textures = JSON.parse(await readFile(path.join(root, 'src/render/assets/surfaceTextures.json'), 'utf8'));
const relativeFiles = new Set([
  ...Object.values(assets.entries ?? {}).map((entry) => `public${entry.uri}`),
  ...Object.values(textures.entries ?? {}).map((entry) => `public${entry.uri}`),
  'public/vendor/three/basis/basis_transcoder.js',
  'public/vendor/three/basis/basis_transcoder.wasm',
]);

let totalBytes = 0;
for (const file of relativeFiles) totalBytes += (await stat(path.join(root, file))).size;
const initialBudget = 25 * 1024 * 1024;
if (totalBytes > initialBudget) throw new Error(`Initial art payload ${totalBytes} bytes exceeds the ${initialBudget}-byte budget.`);
process.stdout.write(`Validated initial GLB + KTX2 + Basis payload · ${(totalBytes / 1024 / 1024).toFixed(2)} MiB / 25.00 MiB.\n`);
