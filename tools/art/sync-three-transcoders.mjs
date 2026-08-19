#!/usr/bin/env node

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(repositoryRoot, 'node_modules/three/examples/jsm/libs/basis');
const destination = path.join(repositoryRoot, 'public/vendor/three/basis');
await mkdir(destination, { recursive: true });
for (const file of await readdir(source)) {
  if (!/\.(?:js|wasm)$/u.test(file)) continue;
  await copyFile(path.join(source, file), path.join(destination, file));
  process.stdout.write(`Copied ${file}\n`);
}
