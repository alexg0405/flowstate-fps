#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const MOTION_VERSION = 1;
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const assets = [
  { file: 'public/assets/art/viewmodels/runner-rifle.glb', rig: 'vx09_rig', root: 'root', kind: 'viewmodel' },
  { file: 'public/assets/art/characters/hunter-ranged.glb', rig: 'hunter_shared_rig', root: 'root', kind: 'hunter' },
  { file: 'public/assets/art/characters/hunter-aggressive.glb', rig: 'hunter_shared_rig', root: 'root', kind: 'hunter' },
];

for (const asset of assets) await normalizeAsset(asset);

async function normalizeAsset(asset) {
  const inputPath = path.join(rootDirectory, asset.file);
  const source = await readFile(inputPath);
  const parsed = parseGlb(source, asset.file);
  const { json, chunks } = parsed;
  const binaryChunk = chunks.find((chunk) => chunk.type === BIN_CHUNK);
  if (!binaryChunk) throw new Error(`${asset.file}: missing GLB binary chunk.`);
  const nodes = json.nodes ?? [];
  const rigIndex = nodes.findIndex((node) => node.name === asset.rig);
  const rootIndex = nodes.findIndex((node) => node.name === asset.root);
  if (rigIndex < 0 || rootIndex < 0) throw new Error(`${asset.file}: missing ${asset.rig}/${asset.root} hierarchy.`);

  const rigNode = nodes[rigIndex];
  const rootNode = nodes[rootIndex];
  const rigChildren = rigNode.children ?? [];
  const rigidChildren = rigChildren.filter((child) => child !== rootIndex);
  if (rigidChildren.length > 0) {
    rootNode.children = [...new Set([...(rootNode.children ?? []), ...rigidChildren])];
    rigNode.children = [rootIndex];
  }

  const animations = json.animations ?? [];
  const alreadyNormalized = animations.length > 0
    && rigidChildren.length === 0
    && animations.every((animation) => animation.extras?.flowstateMotionVersion === MOTION_VERSION);
  if (alreadyNormalized) {
    process.stdout.write(`${asset.file}: animated hierarchy already normalized.\n`);
    return;
  }

  const appended = [];
  let binaryLength = json.buffers?.[0]?.byteLength ?? binaryChunk.data.length;
  if (binaryLength > binaryChunk.data.length) throw new Error(`${asset.file}: invalid primary buffer length.`);

  const appendAccessor = (values, type, count) => {
    const data = floats(values);
    const byteOffset = binaryLength + appended.reduce((total, entry) => total + entry.length, 0);
    const bufferView = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length });
    const accessor = json.accessors.length;
    json.accessors.push({ bufferView, componentType: 5126, count, type });
    appended.push(data);
    return accessor;
  };

  for (const animation of animations) {
    const rootChannels = animation.channels
      .map((channel) => ({ channel, sampler: animation.samplers[channel.sampler] }))
      .filter(({ channel }) => channel.target.node === rootIndex);
    const rotation = rootChannels.find(({ channel }) => channel.target.path === 'rotation');
    const translation = rootChannels.find(({ channel }) => channel.target.path === 'translation');
    const timeAccessor = rotation?.sampler.input ?? translation?.sampler.input;
    if (timeAccessor === undefined) throw new Error(`${asset.file}:${animation.name}: root has no animation sampler.`);
    const count = json.accessors[timeAccessor]?.count;
    if (!Number.isInteger(count) || count < 2) throw new Error(`${asset.file}:${animation.name}: invalid animation key count.`);

    const translations = [];
    const rotations = [];
    for (let index = 0; index < count; index += 1) {
      const t = index / (count - 1);
      const motion = motionFor(asset.kind, animation.name, t);
      translations.push(...motion.translation);
      rotations.push(...quaternionFromEuler(...motion.euler));
    }
    const translationAccessor = appendAccessor(translations, 'VEC3', count);
    const rotationAccessor = appendAccessor(rotations, 'VEC4', count);

    if (translation) {
      translation.sampler.input = timeAccessor;
      translation.sampler.output = translationAccessor;
      translation.sampler.interpolation = 'LINEAR';
    } else {
      animation.samplers.push({ input: timeAccessor, output: translationAccessor, interpolation: 'LINEAR' });
      animation.channels.push({ sampler: animation.samplers.length - 1, target: { node: rootIndex, path: 'translation' } });
    }
    if (rotation) {
      rotation.sampler.input = timeAccessor;
      rotation.sampler.output = rotationAccessor;
      rotation.sampler.interpolation = 'LINEAR';
    } else {
      animation.samplers.push({ input: timeAccessor, output: rotationAccessor, interpolation: 'LINEAR' });
      animation.channels.push({ sampler: animation.samplers.length - 1, target: { node: rootIndex, path: 'rotation' } });
    }
    animation.extras = { ...(animation.extras ?? {}), flowstateMotionVersion: MOTION_VERSION };
  }

  if (!json.buffers?.[0]) throw new Error(`${asset.file}: missing primary buffer definition.`);
  json.buffers[0].byteLength = binaryLength + appended.reduce((total, entry) => total + entry.length, 0);
  binaryChunk.data = Buffer.concat([binaryChunk.data.subarray(0, binaryLength), ...appended]);
  await writeGlb(inputPath, json, chunks);
  process.stdout.write(`${asset.file}: normalized ${animations.length} clips and bound ${rigidChildren.length} rendered/socket nodes.\n`);
}

function motionFor(kind, name, t) {
  const wave = Math.sin(Math.PI * t);
  const cycle = Math.sin(Math.PI * 2 * t);
  if (kind === 'viewmodel') {
    if (name === 'vm_equip') return motion([0, -0.08 * (1 - t), -0.3 * (1 - t)], [0.08 * (1 - t), 0, 0.3 * (1 - t)]);
    if (name === 'vm_idle') return motion([0, cycle * 0.008, 0], [cycle * 0.006, 0, cycle * 0.004]);
    if (name === 'vm_sprint') return motion([cycle * 0.018, Math.abs(cycle) * -0.025, 0.05], [0.13, 0, -0.22 + cycle * 0.035]);
    if (name === 'vm_fire_01') return motion([0, 0.045 * wave, 0.075 * wave], [-0.1 * wave, 0.018 * wave, -0.014 * wave]);
    if (name === 'vm_fire_02') return motion([0, 0.052 * wave, 0.085 * wave], [-0.125 * wave, -0.02 * wave, 0.016 * wave]);
    if (name === 'vm_ads_in') return motion([0, 0.012 * wave, -0.025 * wave], [0, 0, -0.025 * wave]);
    if (name === 'vm_ads_out') return motion([0, -0.008 * wave, 0.02 * wave], [0, 0, 0.025 * wave]);
    if (name === 'vm_reload_tactical') return motion([-0.08 * wave, -0.04 * wave, 0.05 * wave], [0.12 * wave, -0.08 * wave, 0.28 * wave]);
    if (name === 'vm_reload_empty') return motion([-0.1 * wave, -0.06 * wave, 0.08 * wave], [0.18 * wave, -0.12 * wave, 0.36 * wave]);
    if (name === 'vm_melee') return motion([0.12 * wave, 0.1 * wave, -0.08 * wave], [-0.08 * wave, -0.42 * wave, 0.2 * wave]);
    if (name === 'vm_grapple_cast') return motion([-0.1 * wave, 0, -0.08 * wave], [-0.04 * wave, -0.24 * wave, -0.08 * wave]);
    if (name === 'vm_grapple_hold') return motion([cycle * 0.008, 0, -0.04], [0, -0.09 + cycle * 0.012, -0.04]);
    if (name === 'vm_grapple_release') return motion([0.06 * wave, 0, 0.08 * wave], [0.04 * wave, 0.18 * wave, 0.08 * wave]);
  }

  if (name === 'hunter_idle') return motion([0, cycle * 0.018, 0], [0, cycle * 0.012, cycle * 0.006]);
  if (name === 'hunter_run') return motion([cycle * 0.025, Math.abs(Math.sin(Math.PI * 4 * t)) * 0.055, 0], [0.08, 0, cycle * 0.035]);
  if (name === 'hunter_strafe_l') return motion([-0.08 * wave, 0.025 * wave, 0], [0, 0.08 * wave, 0.14 * wave]);
  if (name === 'hunter_strafe_r') return motion([0.08 * wave, 0.025 * wave, 0], [0, -0.08 * wave, -0.14 * wave]);
  if (name === 'hunter_fire') return motion([0, 0, 0.04 * wave], [-0.13 * wave, 0, 0]);
  if (name === 'hunter_melee') return motion([0.1 * wave, 0, -0.16 * wave], [-0.08 * wave, -0.34 * wave, 0.16 * wave]);
  if (name === 'hunter_hit') return motion([0, 0, 0.07 * wave], [0.24 * wave, 0.1 * wave, -0.08 * wave]);
  if (name === 'hunter_death') return motion([0, -0.28 * t, 0.08 * t], [0.18 * t, 0, 1.18 * t]);
  if (name === 'hunter_jump') return motion([0, 0.34 * wave, 0], [-0.08 * wave, 0, 0]);
  if (name === 'hunter_vault') return motion([0, 0.25 * wave, -0.12 * wave], [-0.4 * wave, 0, 0]);
  if (name === 'hunter_drop') return motion([0, -0.22 * t, 0], [0.08 * wave, 0, 0]);
  // Starts compressed and recovers, rather than easing in and out of neutral. A
  // sin(pi t) shape is zero at both sampled endpoints, so a short clip carried no
  // measurable motion at all -- which is also not what a landing looks like.
  if (name === 'hunter_land') return motion([0, -0.12 * (1 - t), 0], [0.18 * (1 - t), 0, 0]);
  return motion([0, 0, 0], [0, 0, 0]);
}

function motion(translation, euler) {
  return { translation, euler };
}

function quaternionFromEuler(x, y, z) {
  const c1 = Math.cos(x / 2); const c2 = Math.cos(y / 2); const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2); const s2 = Math.sin(y / 2); const s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function floats(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function parseGlb(source, label) {
  if (source.readUInt32LE(0) !== GLB_MAGIC || source.readUInt32LE(4) !== 2) throw new Error(`${label}: not a glTF 2.0 binary.`);
  const chunks = [];
  let offset = 12;
  while (offset < source.length) {
    const byteLength = source.readUInt32LE(offset);
    const type = source.readUInt32LE(offset + 4);
    chunks.push({ type, data: Buffer.from(source.subarray(offset + 8, offset + 8 + byteLength)) });
    offset += 8 + byteLength;
  }
  const jsonChunk = chunks.find((chunk) => chunk.type === JSON_CHUNK);
  if (!jsonChunk) throw new Error(`${label}: missing JSON chunk.`);
  const json = JSON.parse(jsonChunk.data.toString('utf8').replace(/[\u0000\u0020]+$/u, ''));
  return { json, chunks };
}

async function writeGlb(inputPath, json, chunks) {
  const serialized = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.alloc(Math.ceil(serialized.length / 4) * 4, 0x20);
  serialized.copy(paddedJson);
  chunks.find((chunk) => chunk.type === JSON_CHUNK).data = paddedJson;
  for (const chunk of chunks) {
    if (chunk.data.length % 4 !== 0) chunk.data = Buffer.concat([chunk.data, Buffer.alloc(4 - chunk.data.length % 4)]);
  }
  const totalLength = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0);
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(GLB_MAGIC, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(totalLength, 8);
  let offset = 12;
  for (const chunk of chunks) {
    output.writeUInt32LE(chunk.data.length, offset); output.writeUInt32LE(chunk.type, offset + 4);
    chunk.data.copy(output, offset + 8); offset += 8 + chunk.data.length;
  }
  const tempPath = `${inputPath}.animation.tmp`;
  await writeFile(tempPath, output);
  await rename(tempPath, inputPath);
}
