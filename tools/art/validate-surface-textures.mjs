#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(await readFile(path.join(root, 'src/render/assets/surfaceTextures.json'), 'utf8'));
const signature = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
let totalBytes = 0;

for (const [id, definition] of Object.entries(catalog.entries ?? {})) {
  const file = path.join(root, 'public', definition.uri.replace(/^\//u, ''));
  const name = path.basename(file, '.ktx2');
  const data = await readFile(file);
  const errors = [];
  if (!data.subarray(0, signature.length).equals(signature)) errors.push('invalid KTX2 signature');
  const width = data.readUInt32LE(20);
  const height = data.readUInt32LE(24);
  const levels = data.readUInt32LE(40);
  const supercompression = data.readUInt32LE(44);
  if (width !== 1024 || height !== 1024) errors.push(`expected 1024x1024, received ${width}x${height}`);
  if (levels !== 11) errors.push(`expected 11 mip levels, received ${levels}`);
  if (supercompression !== 1) errors.push(`expected BasisLZ supercompression, received scheme ${supercompression}`);
  if (errors.length) throw new Error(`${name}.ktx2: ${errors.join('; ')}`);
  totalBytes += data.byteLength;
  const hash = createHash('sha256').update(data).digest('hex');
  if (definition.byteLength !== data.byteLength) errors.push(`catalog byteLength ${definition.byteLength} != ${data.byteLength}`);
  if (definition.hash !== `sha256:${hash}`) errors.push(`catalog hash does not match ${id}`);
  if (!Number.isInteger(definition.gpuBytes) || definition.gpuBytes <= 0) errors.push('catalog gpuBytes must be positive');
  if (errors.length) throw new Error(`${name}.ktx2: ${errors.join('; ')}`);
  process.stdout.write(`OK ${name}.ktx2 · ${width}x${height} · ${levels} mips · sha256:${hash.slice(0, 12)}…\n`);
}

if (totalBytes > 4 * 1024 * 1024) throw new Error(`Surface texture payload ${totalBytes} bytes exceeds the 4 MB budget.`);
process.stdout.write(`Validated ${Object.keys(catalog.entries ?? {}).length} ETC1S/KTX2 sheets · ${(totalBytes / 1024).toFixed(1)} KiB total.\n`);
