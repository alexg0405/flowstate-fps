#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const JSON_CHUNK = 0x4e4f534a;
const GLB_MAGIC = 0x46546c67;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inputPath = path.join(root, 'public/assets/art/viewmodels/runner-rifle.glb');
const tempPath = `${inputPath}.clips.tmp`;

const desiredClips = [
  ['vm_equip', 'vm_idle'],
  ['vm_idle', 'vm_idle'],
  ['vm_sprint', 'vm_sprint'],
  ['vm_fire_01', 'vm_fire'],
  ['vm_fire_02', 'vm_fire'],
  ['vm_ads_in', 'vm_ads_in'],
  ['vm_ads_out', 'vm_ads_out'],
  ['vm_reload_tactical', 'vm_reload'],
  ['vm_reload_empty', 'vm_reload'],
  ['vm_melee', 'vm_melee'],
  ['vm_grapple_cast', 'vm_ads_in'],
  ['vm_grapple_hold', 'vm_idle'],
  ['vm_grapple_release', 'vm_ads_out'],
];

const source = await readFile(inputPath);
if (source.readUInt32LE(0) !== GLB_MAGIC || source.readUInt32LE(4) !== 2) {
  throw new Error(`${path.relative(root, inputPath)} is not a glTF 2.0 binary.`);
}

const chunks = [];
let offset = 12;
while (offset < source.length) {
  const byteLength = source.readUInt32LE(offset);
  const type = source.readUInt32LE(offset + 4);
  chunks.push({ type, data: source.subarray(offset + 8, offset + 8 + byteLength) });
  offset += 8 + byteLength;
}

const jsonChunk = chunks.find((chunk) => chunk.type === JSON_CHUNK);
if (!jsonChunk) throw new Error('The viewmodel GLB has no JSON chunk.');
const document = JSON.parse(jsonChunk.data.toString('utf8').replace(/[\u0000\u0020]+$/u, ''));
const originalAnimations = Array.isArray(document.animations) ? document.animations : [];
const animationsByName = new Map(originalAnimations.map((animation) => [animation.name, animation]));
let changed = false;

for (const [desiredName, legacyName] of desiredClips) {
  if (animationsByName.has(desiredName)) continue;
  const legacy = animationsByName.get(legacyName);
  if (!legacy) throw new Error(`Cannot create ${desiredName}; source clip ${legacyName} is missing.`);
  const duplicate = structuredClone(legacy);
  duplicate.name = desiredName;
  animationsByName.set(desiredName, duplicate);
  changed = true;
}

if (!changed) {
  process.stdout.write('VX-09 viewmodel already has the complete 13-clip contract.\n');
  process.exit(0);
}

const desiredNames = new Set(desiredClips.map(([name]) => name));
document.animations = [
  ...desiredClips.map(([name]) => animationsByName.get(name)),
  ...originalAnimations.filter((animation) => !desiredNames.has(animation.name) && animation.name !== 'vm_fire' && animation.name !== 'vm_reload'),
];

const serialized = Buffer.from(JSON.stringify(document));
const paddedJson = Buffer.alloc(Math.ceil(serialized.length / 4) * 4, 0x20);
serialized.copy(paddedJson);
jsonChunk.data = paddedJson;

const totalLength = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0);
const output = Buffer.alloc(totalLength);
output.writeUInt32LE(GLB_MAGIC, 0);
output.writeUInt32LE(2, 4);
output.writeUInt32LE(totalLength, 8);
offset = 12;
for (const chunk of chunks) {
  output.writeUInt32LE(chunk.data.length, offset);
  output.writeUInt32LE(chunk.type, offset + 4);
  chunk.data.copy(output, offset + 8);
  offset += 8 + chunk.data.length;
}

await writeFile(tempPath, output);
await rename(tempPath, inputPath);
process.stdout.write('Normalized VX-09 viewmodel to the complete 13-clip contract.\n');
