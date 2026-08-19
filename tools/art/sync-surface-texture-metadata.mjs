#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'src/render/assets/surfaceTextures.json');
const check = process.argv.includes('--check');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
let changed = false;

for (const entry of Object.values(catalog.entries ?? {})) {
  const data = await readFile(path.join(root, 'public', entry.uri.replace(/^\//u, '')));
  const hash = `sha256:${createHash('sha256').update(data).digest('hex')}`;
  if (entry.hash !== hash || entry.byteLength !== data.byteLength) changed = true;
  entry.hash = hash;
  entry.byteLength = data.byteLength;
}

if (check) {
  if (changed) throw new Error('Surface texture metadata is stale. Run npm run art:sync-metadata.');
  process.stdout.write('Surface texture metadata is synchronized.\n');
} else {
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  process.stdout.write(`Synchronized ${Object.keys(catalog.entries ?? {}).length} surface texture entries.\n`);
}
