import { createHash } from 'node:crypto';
import { getBounds, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const KTX2_IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const COMPONENT_BYTES = new Map([
  [5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4],
]);
const TYPE_COMPONENTS = new Map([
  ['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4], ['MAT2', 4], ['MAT3', 9], ['MAT4', 16],
]);
const ioPromise = MeshoptDecoder.ready.then(() => new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder }));

export async function inspectAssetGlb(buffer, uniformScale = 1) {
  const parsed = parseGlb(buffer);
  const summary = inspectGlb(parsed);
  const bounds = await inspectBounds(buffer, uniformScale);
  const memoryEstimate = inspectMemory(parsed);
  return {
    parsed,
    summary,
    hash: `sha256:${createHash('sha256').update(buffer).digest('hex')}`,
    byteLength: buffer.byteLength,
    bounds,
    memoryEstimate,
  };
}

export function parseGlb(buffer) {
  if (buffer.byteLength < 20) throw new Error('file is too small to be a GLB.');
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('invalid GLB magic.');
  if (buffer.readUInt32LE(4) !== 2) throw new Error(`unsupported GLB version ${buffer.readUInt32LE(4)}.`);
  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength !== buffer.byteLength) throw new Error(`declared length ${declaredLength} != file length ${buffer.byteLength}.`);
  let offset = 12;
  let json;
  let binary = Buffer.alloc(0);
  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) throw new Error('truncated GLB chunk header.');
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > buffer.byteLength) throw new Error('truncated GLB chunk payload.');
    const chunk = buffer.subarray(offset, offset + length);
    if (type === JSON_CHUNK) json = JSON.parse(chunk.toString('utf8').replace(/\u0000+$/u, '').trimEnd());
    else if (type === BIN_CHUNK) binary = chunk;
    offset += length;
  }
  if (!json) throw new Error('GLB does not contain a JSON chunk.');
  if (json.asset?.version !== '2.0') throw new Error(`glTF asset.version must be 2.0, got ${json.asset?.version}.`);
  return { json, binary };
}

export function inspectGlb({ json, binary }) {
  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
      const count = json.accessors?.[accessorIndex]?.count ?? 0;
      triangles += primitiveTriangles(primitive.mode ?? 4, count);
    }
  }
  const textureDimensions = [];
  for (const texture of json.textures ?? []) {
    const sourceIndex = texture.extensions?.KHR_texture_basisu?.source ?? texture.source;
    const image = json.images?.[sourceIndex];
    if (image?.bufferView === undefined || image.mimeType !== 'image/ktx2') continue;
    const bufferView = json.bufferViews?.[image.bufferView];
    if (!bufferView) continue;
    const start = bufferView.byteOffset ?? 0;
    const bytes = binary.subarray(start, start + bufferView.byteLength);
    const dimensions = parseKtx2Dimensions(bytes);
    if (dimensions) textureDimensions.push(dimensions);
  }
  const maxBones = Math.max(0, ...(json.skins ?? []).map((skin) => skin.joints?.length ?? 0));
  return {
    triangles,
    materials: json.materials?.length ?? 0,
    textures: json.textures?.length ?? 0,
    animations: json.animations?.length ?? 0,
    maxBones,
    textureDimensions,
  };
}

async function inspectBounds(buffer, uniformScale) {
  const io = await ioPromise;
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const document = await io.readBinary(bytes);
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('asset does not contain a scene.');
  const inspected = getBounds(scene);
  const minimum = inspected.min.map((value) => value * uniformScale);
  const maximum = inspected.max.map((value) => value * uniformScale);
  const halfExtents = maximum.map((value, axis) => (value - minimum[axis]) * 0.5);
  return {
    min: minimum.map(roundFloat),
    max: maximum.map(roundFloat),
    radius: roundFloat(Math.hypot(...halfExtents)),
  };
}

function inspectMemory({ json }) {
  const gpuAccessors = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.indices !== undefined) gpuAccessors.add(primitive.indices);
      for (const accessor of Object.values(primitive.attributes ?? {})) gpuAccessors.add(accessor);
      for (const target of primitive.targets ?? []) {
        for (const accessor of Object.values(target)) gpuAccessors.add(accessor);
      }
    }
  }
  const cpuAccessors = new Set(gpuAccessors);
  for (const animation of json.animations ?? []) {
    for (const sampler of animation.samplers ?? []) {
      cpuAccessors.add(sampler.input);
      cpuAccessors.add(sampler.output);
    }
  }
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) cpuAccessors.add(skin.inverseBindMatrices);
  }

  const imageBufferViews = new Set((json.images ?? []).map((image) => image.bufferView).filter((index) => index !== undefined));
  const gpuBufferViews = accessorBufferViews(json, gpuAccessors);
  const cpuBufferViews = accessorBufferViews(json, cpuAccessors);
  for (const index of imageBufferViews) {
    gpuBufferViews.add(index);
    cpuBufferViews.add(index);
  }
  const gpuBytes = sumBufferViewBytes(json, gpuBufferViews);
  const cpuBytes = sumBufferViewBytes(json, cpuBufferViews);
  return { cpuBytes, gpuBytes };
}

function accessorBufferViews(json, indices) {
  const bufferViews = new Set();
  for (const index of indices) {
    const accessor = json.accessors?.[index];
    if (!accessor) continue;
    if (!COMPONENT_BYTES.has(accessor.componentType) || !TYPE_COMPONENTS.has(accessor.type)) {
      throw new Error(`accessor ${index} uses an unsupported component/type.`);
    }
    if (accessor.bufferView !== undefined) bufferViews.add(accessor.bufferView);
    if (accessor.sparse?.indices?.bufferView !== undefined) bufferViews.add(accessor.sparse.indices.bufferView);
    if (accessor.sparse?.values?.bufferView !== undefined) bufferViews.add(accessor.sparse.values.bufferView);
  }
  return bufferViews;
}

function sumBufferViewBytes(json, indices) {
  let bytes = 0;
  for (const index of indices) bytes += json.bufferViews?.[index]?.byteLength ?? 0;
  return bytes;
}

function primitiveTriangles(mode, count) {
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function parseKtx2Dimensions(bytes) {
  if (bytes.byteLength < 28 || !bytes.subarray(0, 12).equals(KTX2_IDENTIFIER)) return undefined;
  return { width: bytes.readUInt32LE(20), height: bytes.readUInt32LE(24) };
}


function roundFloat(value) {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}
