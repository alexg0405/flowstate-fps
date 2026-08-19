#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inspectAssetGlb } from './glb-inspection.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const options = parseArguments(process.argv.slice(2));
const catalogPath = path.resolve(repositoryRoot, options.catalog);
const publicRoot = path.resolve(repositoryRoot, options.publicRoot);
const original = await readFile(catalogPath, 'utf8');
const catalog = JSON.parse(original);

for (const [id, definition] of Object.entries(catalog.entries ?? {})) {
  const primaryLod = definition.lods?.find((lod) => lod.level === 0);
  if (!primaryLod) throw new Error(`${id}: a level-0 LOD is required before metadata can be synchronized.`);
  if (primaryLod.uri !== definition.uri) throw new Error(`${id}: level-0 LOD URI must match the primary URI.`);

  for (const lod of definition.lods) {
    const lodPath = publicPath(lod.uri);
    const inspected = await inspectAssetGlb(await readFile(lodPath), definition.scale);
    lod.hash = inspected.hash;
    lod.byteLength = inspected.byteLength;
    if (lod.level === 0) {
      definition.hash = inspected.hash;
      definition.byteLength = inspected.byteLength;
      definition.bounds = inspected.bounds;
      definition.memoryEstimate = inspected.memoryEstimate;
    }
  }
}

const synchronized = `${JSON.stringify(catalog, null, 2)}\n`;
if (options.check) {
  if (synchronized !== original) {
    process.stderr.write('Asset catalog metadata is stale. Run npm run art:sync-metadata.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Asset catalog metadata is synchronized.\n');
  }
} else {
  await writeFile(catalogPath, synchronized, 'utf8');
  process.stdout.write(`Synchronized ${Object.keys(catalog.entries ?? {}).length} asset catalog entries.\n`);
}

function publicPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('/')) throw new Error(`Asset URI must be root-relative: ${uri}`);
  const resolved = path.resolve(publicRoot, uri.slice(1));
  const relative = path.relative(publicRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Asset URI escapes public root: ${uri}`);
  return resolved;
}

function parseArguments(args) {
  const result = { check: false, catalog: 'src/render/assets/catalog.json', publicRoot: 'public' };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--check') result.check = true;
    else if (value === '--catalog') result.catalog = requireValue(args, ++index, '--catalog');
    else if (value === '--public-root') result.publicRoot = requireValue(args, ++index, '--public-root');
    else if (value === '--help') {
      process.stdout.write('Usage: node tools/art/sync-asset-metadata.mjs [--check] [--catalog <path>] [--public-root <path>]\n');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}
