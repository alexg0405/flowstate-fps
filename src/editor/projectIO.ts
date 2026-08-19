import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { LevelDocument, LevelDocumentV2 } from '../contracts';
import { levelDocumentSchema, validateLevel } from '../content/schema';
import { migrateLevelDocument } from '../content/migrations';

export async function exportProject(level: LevelDocument, navMeshData?: Uint8Array): Promise<void> {
  const normalized = migrateLevelDocument(level);
  const archive = createProjectArchive(normalized, navMeshData);
  downloadBlob(new Blob([archive as BlobPart], { type: 'application/octet-stream' }), `${normalized.id}.fpsproj`);
}

/** Creates the exact portable payload used by Save, without invoking browser APIs. */
export function createProjectArchive(level: LevelDocument, navMeshData?: Uint8Array): Uint8Array {
  const normalized = migrateLevelDocument(level);
  const files: Record<string, Uint8Array> = {
    'level.json': strToU8(JSON.stringify(serializableLevel(normalized), null, 2)),
  };
  if (navMeshData) files['navmesh.bin'] = navMeshData;
  return zipSync(files, { level: 6 });
}

export async function saveProjectDirectory(level: LevelDocument, navMeshData?: Uint8Array): Promise<boolean> {
  if (!('showDirectoryPicker' in window)) return false;
  const normalized = migrateLevelDocument(level);
  const directory = await window.showDirectoryPicker({ mode: 'readwrite' });
  await writeFile(directory, 'level.json', new Blob([JSON.stringify(serializableLevel(normalized), null, 2)], { type: 'application/json' }));
  if (navMeshData) await writeFile(directory, 'navmesh.bin', new Blob([navMeshData as BlobPart]));
  else await removeFileIfPresent(directory, 'navmesh.bin');
  return true;
}

export async function importProject(file: File): Promise<{ level: LevelDocumentV2; navMeshData?: Uint8Array }> {
  if (file.name.toLowerCase().endsWith('.json')) {
    return { level: parseLevel(JSON.parse(await file.text()) as unknown) };
  }
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const levelBytes = files['level.json'];
  if (!levelBytes) throw new Error('Project archive does not contain level.json.');
  return {
    level: parseLevel(JSON.parse(strFromU8(levelBytes)) as unknown),
    navMeshData: files['navmesh.bin'],
  };
}

function parseLevel(input: unknown): LevelDocumentV2 {
  const level = levelDocumentSchema.parse(input);
  assertValid(level);
  return level;
}

function assertValid(level: LevelDocumentV2): void {
  const result = validateLevel(level);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
}

/** The deprecated in-memory `primitives` alias is intentionally not serialized. */
function serializableLevel(level: LevelDocumentV2): Omit<LevelDocumentV2, 'primitives'> {
  const { primitives: _primitives, ...canonical } = level;
  return canonical;
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, data: Blob): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function removeFileIfPresent(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (reason) {
    if (reason && typeof reason === 'object' && 'name' in reason && reason.name === 'NotFoundError') return;
    throw reason;
  }
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
