#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'art-src/textures/cyber-dusk-surface-atlas.png');
const intermediateDirectory = path.join(root, 'build/art/textures');
const outputDirectory = path.join(root, 'public/assets/art/textures');
const toktx = process.env.FLOWSTATE_TOKTX ?? path.join(root, '.tooling/ktx-4.4.2-local/bin/toktx');
if (!existsSync(toktx)) throw new Error(`toktx 4.4.2 was not found at ${toktx}. Set FLOWSTATE_TOKTX to the pinned executable.`);
const metadata = await sharp(source).metadata();
if (!metadata.width || !metadata.height) throw new Error('The cyber-dusk surface atlas has no readable dimensions.');

const cellWidth = Math.floor(metadata.width / 2);
const cellHeight = Math.floor(metadata.height / 2);
const materials = [
  ['ceramic-composite', 0, 0],
  ['graphite-deck', cellWidth, 0],
  ['brushed-gunmetal', 0, cellHeight],
  ['signal-circuit', cellWidth, cellHeight],
];

await mkdir(intermediateDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all(materials.map(async ([name, left, top]) => {
  const png = path.join(intermediateDirectory, `${name}.png`);
  await sharp(source)
    .extract({ left, top, width: cellWidth, height: cellHeight })
    .resize(1024, 1024, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(png);
  run(toktx, [
    '--t2', '--encode', 'etc1s', '--threads', '1', '--clevel', '4', '--qlevel', '180',
    '--genmipmap', '--filter', 'lanczos4', '--assign_oetf', 'srgb', '--',
    path.join(outputDirectory, `${name}.ktx2`), png,
  ]);
}));

process.stdout.write(`Built ${materials.length} ETC1S/KTX2 cyber-dusk surface textures from ${path.relative(root, source)}.\n`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
