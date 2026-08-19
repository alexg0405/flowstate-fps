#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inspectAssetGlb } from './glb-inspection.mjs';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const options = parseArguments(process.argv.slice(2));
const catalogPath = path.resolve(repositoryRoot, options.catalog);
const publicRoot = path.resolve(repositoryRoot, options.publicRoot);
const errors = [];
const warnings = [];
const summaries = [];

try {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  validateCatalog(catalog, errors);
  for (const [id, definition] of Object.entries(catalog.entries ?? {})) {
    for (const lod of Array.isArray(definition.lods) ? definition.lods : []) {
      const filePath = path.join(publicRoot, lod.uri.replace(/^\//, ''));
      const label = lod.level === 0 ? id : `${id}@lod${lod.level}`;
      if (!existsSync(filePath)) {
        const message = `${label}: missing ${path.relative(repositoryRoot, filePath)}`;
        (options.allowMissing ? warnings : errors).push(message);
        continue;
      }
      try {
        const inspected = await inspectAssetGlb(await readFile(filePath), definition.scale);
        summaries.push({
          id: label,
          file: path.relative(repositoryRoot, filePath),
          ...inspected.summary,
          hash: inspected.hash,
          byteLength: inspected.byteLength,
          bounds: inspected.bounds,
          memoryEstimate: inspected.memoryEstimate,
        });
        validateGlb(id, definition, lod, inspected, errors, warnings);
      } catch (error) {
        errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ summaries, warnings, errors }, null, 2)}\n`);
} else {
  for (const summary of summaries) {
    process.stdout.write(
      `OK ${summary.id} · ${summary.triangles.toLocaleString()} tris · ${summary.materials} materials · `
      + `${summary.textures} textures · ${summary.animations} clips\n`,
    );
  }
  for (const warning of warnings) process.stdout.write(`WARN ${warning}\n`);
  for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
  process.stdout.write(
    `Validated ${summaries.length} GLB file(s): ${errors.length} error(s), ${warnings.length} warning(s).\n`,
  );
}

if (errors.length > 0) process.exitCode = 1;

function parseArguments(args) {
  const result = {
    allowMissing: false,
    json: false,
    catalog: 'src/render/assets/catalog.json',
    publicRoot: 'public',
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--allow-missing') result.allowMissing = true;
    else if (value === '--json') result.json = true;
    else if (value === '--catalog') result.catalog = requireValue(args, ++index, '--catalog');
    else if (value === '--public-root') result.publicRoot = requireValue(args, ++index, '--public-root');
    else if (value === '--help') {
      process.stdout.write(
        'Usage: node tools/art/validate-assets.mjs [--allow-missing] [--json] '
        + '[--catalog <path>] [--public-root <path>]\n',
      );
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

function validateCatalog(catalog, output) {
  if (catalog.schemaVersion !== 1) output.push('catalog: schemaVersion must be 1.');
  if (!catalog.entries || typeof catalog.entries !== 'object' || Array.isArray(catalog.entries)) {
    output.push('catalog: entries must be an object.');
    return;
  }
  const uris = new Set();
  const allowedKinds = new Set(['viewmodel', 'character', 'environment']);
  const allowedPreloadGroups = new Set(['startup', 'combat', 'level', 'on-demand']);
  for (const [id, definition] of Object.entries(catalog.entries)) {
    if (!allowedKinds.has(definition.kind)) output.push(`${id}: unsupported kind ${definition.kind}.`);
    if (!id.startsWith(`${definition.kind}.`)) output.push(`${id}: ID prefix must match kind ${definition.kind}.`);
    if (typeof definition.uri !== 'string' || !definition.uri.startsWith('/assets/art/') || !definition.uri.endsWith('.glb')) {
      output.push(`${id}: uri must be a root-relative /assets/art/*.glb path.`);
    }
    if (uris.has(definition.uri)) output.push(`${id}: duplicate uri ${definition.uri}.`);
    uris.add(definition.uri);
    if (!HASH_PATTERN.test(definition.hash)) output.push(`${id}: hash must be sha256:<64 lowercase hex characters>.`);
    if (!Number.isInteger(definition.byteLength) || definition.byteLength <= 0) output.push(`${id}: byteLength must be positive.`);
    validateLods(id, definition, output);
    validateVariants(id, definition.variants, output);
    validateBounds(id, definition.bounds, output);
    if (!allowedPreloadGroups.has(definition.preloadGroup)) output.push(`${id}: unsupported preloadGroup ${definition.preloadGroup}.`);
    validateMemoryEstimate(id, definition.memoryEstimate, output);
    if (typeof definition.source !== 'string' || !definition.source.endsWith('.blend')) {
      output.push(`${id}: source must identify its Blender file.`);
    }
    if (!Number.isFinite(definition.scale) || definition.scale <= 0) output.push(`${id}: scale must be positive.`);
    if (!definition.clips || typeof definition.clips !== 'object') output.push(`${id}: clips must be an object.`);
    if (!Array.isArray(definition.sockets)) output.push(`${id}: sockets must be an array.`);
    if (!Array.isArray(definition.tags) || definition.tags.length === 0) output.push(`${id}: tags must be non-empty.`);
    const budget = definition.validation;
    for (const field of ['maxTriangles', 'maxMaterials', 'maxTextures', 'maxTextureSize']) {
      if (!Number.isInteger(budget?.[field]) || budget[field] <= 0) output.push(`${id}: validation.${field} must be positive.`);
    }
    if (!Number.isInteger(budget?.maxBones) || budget.maxBones < 0) output.push(`${id}: validation.maxBones must be non-negative.`);
    if (budget?.minimumRigAttachments !== undefined && (!Number.isInteger(budget.minimumRigAttachments) || budget.minimumRigAttachments < 0)) {
      output.push(`${id}: validation.minimumRigAttachments must be a non-negative integer when present.`);
    }
    for (const field of ['requireMeshopt', 'requireKtx2', 'selfContained']) {
      if (typeof budget?.[field] !== 'boolean') output.push(`${id}: validation.${field} must be boolean.`);
    }
  }
}

function validateGlb(id, definition, lod, inspected, output, warningOutput) {
  const { json } = inspected.parsed;
  const { summary } = inspected;
  const budget = definition.validation;
  compareBudget(id, 'triangles', summary.triangles, budget.maxTriangles, output);
  compareBudget(id, 'materials', summary.materials, budget.maxMaterials, output);
  compareBudget(id, 'textures', summary.textures, budget.maxTextures, output);
  compareBudget(id, 'bones per skin', summary.maxBones, budget.maxBones, output);
  for (const { width, height } of summary.textureDimensions) {
    if (width > budget.maxTextureSize || height > budget.maxTextureSize) {
      output.push(`${id}: KTX2 texture ${width}x${height} exceeds ${budget.maxTextureSize}px budget.`);
    }
  }

  const extensions = new Set(json.extensionsUsed ?? []);
  if (budget.requireMeshopt && !extensions.has('EXT_meshopt_compression')) {
    output.push(`${id}: EXT_meshopt_compression is required.`);
  }
  if (budget.requireKtx2 && summary.textures > 0 && !extensions.has('KHR_texture_basisu')) {
    output.push(`${id}: textured asset must use KHR_texture_basisu/KTX2.`);
  }
  if (budget.requireKtx2 && summary.textures > summary.textureDimensions.length) {
    output.push(`${id}: one or more textures are not embedded KTX2 images.`);
  }
  if (budget.selfContained) {
    for (const buffer of json.buffers ?? []) {
      if (buffer.uri && !buffer.uri.startsWith('data:')) output.push(`${id}: external buffer URI ${buffer.uri} is not allowed.`);
    }
    for (const image of json.images ?? []) {
      if (image.uri && !image.uri.startsWith('data:')) output.push(`${id}: external image URI ${image.uri} is not allowed.`);
    }
  }

  const nodeNames = new Set((json.nodes ?? []).map((node) => node.name).filter(Boolean));
  for (const socket of definition.sockets) if (!nodeNames.has(socket)) output.push(`${id}: missing socket node ${socket}.`);
  const animationNames = new Set((json.animations ?? []).map((animation) => animation.name).filter(Boolean));
  for (const clip of Object.values(definition.clips)) if (!animationNames.has(clip)) output.push(`${id}: missing clip ${clip}.`);
  validateAnimationBindings(id, definition, inspected.parsed, output);
  if (summary.textures > 0 && summary.textureDimensions.length === 0) {
    warningOutput.push(`${id}: texture dimensions could not be inspected.`);
  }
  compareMetadata(id, `lods[${lod.level}].hash`, lod.hash, inspected.hash, output);
  compareMetadata(id, `lods[${lod.level}].byteLength`, lod.byteLength, inspected.byteLength, output);
  if (lod.level === 0) {
    compareMetadata(id, 'uri', definition.uri, lod.uri, output);
    compareMetadata(id, 'hash', definition.hash, inspected.hash, output);
    compareMetadata(id, 'byteLength', definition.byteLength, inspected.byteLength, output);
    compareMetadata(id, 'bounds', definition.bounds, inspected.bounds, output);
    compareMetadata(id, 'memoryEstimate', definition.memoryEstimate, inspected.memoryEstimate, output);
  }
}

function validateAnimationBindings(id, definition, parsed, output) {
  const clipNames = [...new Set(Object.values(definition.clips ?? {}))];
  if (clipNames.length === 0) return;
  const { json, binary } = parsed;
  const nodes = json.nodes ?? [];
  const animations = new Map((json.animations ?? []).map((animation) => [animation.name, animation]));
  const meshNodes = new Set(nodes.flatMap((node, index) => node.mesh === undefined ? [] : [index]));
  const socketNodes = (definition.sockets ?? []).map((name) => nodes.findIndex((node) => node.name === name)).filter((index) => index >= 0);
  const descendants = new Map();
  const descendantsOf = (nodeIndex, active = new Set()) => {
    if (descendants.has(nodeIndex)) return descendants.get(nodeIndex);
    if (active.has(nodeIndex)) return new Set([nodeIndex]);
    active.add(nodeIndex);
    const result = new Set([nodeIndex]);
    for (const child of nodes[nodeIndex]?.children ?? []) for (const index of descendantsOf(child, active)) result.add(index);
    active.delete(nodeIndex);
    descendants.set(nodeIndex, result);
    return result;
  };
  const controls = (target, controlledNodes) => [...descendantsOf(target)].some((node) => controlledNodes.has(node));
  const signatures = new Map();

  // Geometry has to hang off the rig in more than one place. Every clip animates the
  // shared root, and the root is an ancestor of everything, so the per-clip check
  // below passes even when a batching step has stripped the limb parenting and left
  // the meshes as loose siblings of the bones -- which is exactly how a set of
  // characters shipped rendering as scattered debris.
  const attachmentPoints = new Set(nodes.flatMap((node, index) => (
    (node.children ?? []).some((child) => meshNodes.has(child)) ? [index] : []
  )));
  const minimumAttachments = definition.validation?.minimumRigAttachments ?? 0;
  if (minimumAttachments > 0 && attachmentPoints.size < minimumAttachments) {
    output.push(`${id}: rendered geometry hangs off ${attachmentPoints.size} rig node(s); expected at least ${minimumAttachments}. A batching step has probably discarded the bone parenting.`);
  }

  for (const clipName of clipNames) {
    const animation = animations.get(clipName);
    if (!animation) continue;
    if (animation.extras?.flowstateMotionVersion !== 1) {
      output.push(`${id}: clip ${clipName} is missing authored Flow State motion metadata.`);
    }
    const targets = new Set((animation.channels ?? []).map((channel) => channel.target?.node).filter(Number.isInteger));
    if (![...targets].some((target) => controls(target, meshNodes))) {
      output.push(`${id}: clip ${clipName} does not control an ancestor of rendered geometry.`);
    }
    for (const socketNode of socketNodes) {
      if (![...targets].some((target) => descendantsOf(target).has(socketNode))) {
        output.push(`${id}: clip ${clipName} does not carry socket ${nodes[socketNode]?.name}.`);
      }
    }
    const motionOutputs = (animation.channels ?? []).flatMap((channel) => {
      if (!['translation', 'rotation'].includes(channel.target?.path) || !controls(channel.target.node, meshNodes)) return [];
      const outputAccessor = animation.samplers?.[channel.sampler]?.output;
      return Number.isInteger(outputAccessor) ? [outputAccessor] : [];
    });
    const dynamic = motionOutputs.some((accessor) => accessorVariation(json, binary, accessor) > 0.001);
    if (!dynamic) output.push(`${id}: clip ${clipName} has no measurable rendered motion.`);
    const signature = [...new Set(motionOutputs)].sort((a, b) => a - b).join(',');
    const duplicate = signatures.get(signature);
    if (signature && duplicate) output.push(`${id}: clips ${duplicate} and ${clipName} share an identical motion signature.`);
    else if (signature) signatures.set(signature, clipName);
  }
}

function accessorVariation(json, binary, accessorIndex) {
  const accessor = json.accessors?.[accessorIndex];
  const bufferView = json.bufferViews?.[accessor?.bufferView];
  if (!accessor || !bufferView || accessor.componentType !== 5126 || bufferView.buffer !== 0 || bufferView.extensions?.EXT_meshopt_compression) return 0;
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  if (!components) return 0;
  const stride = bufferView.byteStride ?? components * 4;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const minimum = Array(components).fill(Infinity);
  const maximum = Array(components).fill(-Infinity);
  for (let item = 0; item < accessor.count; item += 1) {
    for (let component = 0; component < components; component += 1) {
      const offset = start + item * stride + component * 4;
      if (offset + 4 > binary.length) return 0;
      const value = binary.readFloatLE(offset);
      minimum[component] = Math.min(minimum[component], value);
      maximum[component] = Math.max(maximum[component], value);
    }
  }
  return Math.max(...maximum.map((value, component) => value - minimum[component]));
}

function compareBudget(id, label, actual, maximum, output) {
  if (actual > maximum) output.push(`${id}: ${actual} ${label} exceeds budget ${maximum}.`);
}

function validateLods(id, definition, output) {
  if (!Array.isArray(definition.lods) || definition.lods.length === 0) {
    output.push(`${id}: lods must contain at least LOD0.`);
    return;
  }
  const levels = new Set();
  const uris = new Set();
  let previousLevel = -1;
  let previousDistance = -1;
  for (const [index, lod] of definition.lods.entries()) {
    if (!Number.isInteger(lod.level) || lod.level < 0) output.push(`${id}: lods[${index}].level must be non-negative.`);
    if (levels.has(lod.level)) output.push(`${id}: duplicate LOD level ${lod.level}.`);
    levels.add(lod.level);
    if (lod.level !== index) output.push(`${id}: LOD levels must be contiguous and start at zero.`);
    if (lod.level <= previousLevel) output.push(`${id}: lods must be ordered by increasing level.`);
    previousLevel = lod.level;
    if (typeof lod.uri !== 'string' || !lod.uri.startsWith('/assets/art/') || !lod.uri.endsWith('.glb')) {
      output.push(`${id}: lods[${index}].uri must be a root-relative /assets/art/*.glb path.`);
    }
    if (uris.has(lod.uri)) output.push(`${id}: duplicate LOD URI ${lod.uri}.`);
    uris.add(lod.uri);
    if (!Number.isFinite(lod.minDistance) || lod.minDistance < 0 || (index > 0 && lod.minDistance <= previousDistance)) {
      output.push(`${id}: LOD minDistance values must be finite, non-negative, and strictly ascending.`);
    }
    previousDistance = lod.minDistance;
    if (!HASH_PATTERN.test(lod.hash)) output.push(`${id}: lods[${index}].hash must be a SHA-256 hash.`);
    if (!Number.isInteger(lod.byteLength) || lod.byteLength <= 0) output.push(`${id}: lods[${index}].byteLength must be positive.`);
  }
  if (!levels.has(0)) output.push(`${id}: lods must include level 0.`);
  if (definition.lods[0]?.minDistance !== 0) output.push(`${id}: LOD0 minDistance must be zero.`);
}

function validateVariants(id, variants, output) {
  if (!Array.isArray(variants) || variants.length === 0) {
    output.push(`${id}: variants must contain at least the base material variant.`);
    return;
  }
  const ids = new Set();
  for (const [index, variant] of variants.entries()) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(variant.id)) output.push(`${id}: variants[${index}].id must be kebab-case.`);
    if (ids.has(variant.id)) output.push(`${id}: duplicate variant ID ${variant.id}.`);
    ids.add(variant.id);
    if (typeof variant.label !== 'string' || variant.label.length === 0) output.push(`${id}: variants[${index}].label is required.`);
    if (!/^#[a-fA-F0-9]{6}$/u.test(variant.accent)) output.push(`${id}: variants[${index}].accent must be a six-digit hex color.`);
  }
  if (!ids.has('base')) output.push(`${id}: variants must include base.`);
}

function validateBounds(id, bounds, output) {
  if (!bounds || !isFiniteVector(bounds.min) || !isFiniteVector(bounds.max)) {
    output.push(`${id}: bounds must contain finite min/max vec3 values.`);
    return;
  }
  if (bounds.max.some((value, axis) => value < bounds.min[axis])) output.push(`${id}: bounds.max must not be below bounds.min.`);
  if (!Number.isFinite(bounds.radius) || bounds.radius <= 0) output.push(`${id}: bounds.radius must be positive.`);
  const expectedRadius = Math.hypot(...bounds.max.map((value, axis) => (value - bounds.min[axis]) * 0.5));
  if (Number.isFinite(bounds.radius) && Math.abs(bounds.radius - expectedRadius) > 0.000002) {
    output.push(`${id}: bounds.radius must match the AABB half-diagonal.`);
  }
}

function validateMemoryEstimate(id, estimate, output) {
  for (const field of ['cpuBytes', 'gpuBytes']) {
    if (!Number.isInteger(estimate?.[field]) || estimate[field] <= 0) output.push(`${id}: memoryEstimate.${field} must be positive.`);
  }
}

function isFiniteVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function compareMetadata(id, label, catalogValue, actualValue, output) {
  if (JSON.stringify(catalogValue) !== JSON.stringify(actualValue)) {
    output.push(`${id}: stale ${label}; run npm run art:sync-metadata.`);
  }
}
