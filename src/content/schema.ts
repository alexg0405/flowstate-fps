import { z } from 'zod';
import type { LevelDocument, LevelDocumentV2 } from '../contracts';
import { isAssetId } from '../render/assets/catalog';
import { DEFAULT_ASSET_CATALOG_VERSION, DEFAULT_ENVIRONMENT_PRESET_ID, migrateLevelDocument } from './migrations';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const transform = z.object({ position: vec3, rotation: vec3, scale: vec3 });
const surface = z.enum(['default', 'wall-run', 'vault', 'mantle', 'no-traverse']);

const levelPrimitiveSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['box', 'ramp']),
  transform,
  color: z.string(),
  collision: z.boolean(),
  surface,
  gateForEncounterId: z.string().min(1).optional(),
});

const collisionPrimitiveV2Schema = levelPrimitiveSchema.extend({
  traversal: z.object({
    wallRun: z.boolean(),
    vault: z.boolean(),
    mantle: z.boolean(),
    grapple: z.boolean(),
  }),
  nav: z.object({
    includeInBake: z.boolean(),
    walkable: z.boolean(),
  }),
});

const visualInstanceSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  transform,
  materialVariantId: z.string().min(1).optional(),
  castShadow: z.boolean(),
  receiveShadow: z.boolean(),
  collisionAlignmentId: z.string().min(1).optional(),
  gateVisibilityBindingId: z.string().min(1).optional(),
  // Accepted only as an import bridge; normalized documents never emit it.
  gateForEncounterId: z.string().min(1).optional(),
}).transform(({ gateForEncounterId, ...visual }) => ({
  ...visual,
  gateVisibilityBindingId: visual.gateVisibilityBindingId ?? gateForEncounterId,
}));

const lightInstanceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['point', 'spot']),
  transform,
  color: z.string(),
  intensity: z.number().nonnegative(),
  range: z.number().positive(),
  coneAngle: z.number().positive().max(Math.PI).optional(),
  penumbra: z.number().min(0).max(1).optional(),
  castShadow: z.boolean(),
  gateVisibilityBindingId: z.string().min(1).optional(),
  // Accepted only as an import bridge; normalized documents never emit it.
  gateForEncounterId: z.string().min(1).optional(),
}).transform(({ gateForEncounterId, ...light }) => ({
  ...light,
  gateVisibilityBindingId: light.gateVisibilityBindingId ?? gateForEncounterId,
}));

const spawnSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['player', 'bot-ranged', 'bot-aggressive', 'bot-bulwark', 'bot-resonator']),
  position: vec3,
  rotationY: z.number(),
  encounterId: z.string().min(1).optional(),
  wave: z.number().int().min(0).optional(),
});

const encounterSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  checkpoint: vec3,
  requiredBotIds: z.array(z.string()),
});

const offMeshLinkSchema = z.object({
  id: z.string().min(1),
  start: vec3,
  end: vec3,
  bidirectional: z.boolean(),
  action: z.enum(['jump', 'vault', 'drop']),
});

export const legacyLevelDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  units: z.literal('meters'),
  primitives: z.array(levelPrimitiveSchema),
  spawns: z.array(spawnSchema),
  encounters: z.array(encounterSchema),
  offMeshLinks: z.array(offMeshLinkSchema),
  exit: vec3,
});

const vistaHintSchema = z.object({
  id: z.string().min(1),
  at: vec3,
  radius: z.number().positive(),
  yaw: z.number(),
  pitch: z.number(),
});

export const levelDocumentV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  name: z.string().min(1),
  units: z.literal('meters'),
  collision: z.array(collisionPrimitiveV2Schema),
  visuals: z.array(visualInstanceSchema),
  lights: z.array(lightInstanceSchema),
  environmentPresetId: z.string().min(1),
  assetCatalogVersion: z.string().min(1),
  // Serialized by compatibility clients. `collision` remains canonical.
  primitives: z.array(collisionPrimitiveV2Schema).optional(),
  spawns: z.array(spawnSchema),
  encounters: z.array(encounterSchema),
  offMeshLinks: z.array(offMeshLinkSchema),
  // Absent on every document authored before compositions carried a camera.
  vistaHints: z.array(vistaHintSchema).optional(),
  exit: vec3,
}).transform(({ primitives: _primitives, vistaHints, ...level }): LevelDocumentV2 => {
  const collision = structuredClone(level.collision);
  return { ...level, collision, primitives: collision, vistaHints: vistaHints ?? [] };
});

/** Accepts either serialized generation and always returns normalized V2. */
export const levelDocumentSchema = z.union([legacyLevelDocumentSchema, levelDocumentV2Schema])
  .transform((level): LevelDocumentV2 => migrateLevelDocument(level as LevelDocument));

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateLevel(input: unknown): ValidationResult {
  const parsed = levelDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`), warnings: [] };
  }

  const level = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (level.assetCatalogVersion !== DEFAULT_ASSET_CATALOG_VERSION) {
    errors.push(`Unsupported asset catalog version ${level.assetCatalogVersion}; expected ${DEFAULT_ASSET_CATALOG_VERSION}.`);
  }
  if (level.environmentPresetId !== DEFAULT_ENVIRONMENT_PRESET_ID) {
    errors.push(`Unsupported environment preset ${level.environmentPresetId}; expected ${DEFAULT_ENVIRONMENT_PRESET_ID}.`);
  }
  const ids = new Set<string>();
  for (const item of [...level.collision, ...level.visuals, ...level.lights, ...level.spawns, ...level.encounters, ...level.offMeshLinks, ...level.vistaHints]) {
    if (ids.has(item.id)) errors.push(`Duplicate id: ${item.id}`);
    ids.add(item.id);
  }
  if (level.spawns.filter((spawn) => spawn.kind === 'player').length !== 1) {
    errors.push('A level must contain exactly one player spawn.');
  }
  const collisionIds = new Set(level.collision.map((item) => item.id));
  const spawnIds = new Set(level.spawns.map((spawn) => spawn.id));
  const botSpawnIds = new Set(level.spawns.filter((spawn) => spawn.kind !== 'player').map((spawn) => spawn.id));
  const encounterIds = new Set(level.encounters.map((encounter) => encounter.id));
  const assignedBots = new Set<string>();
  for (const encounter of level.encounters) {
    for (const botId of encounter.requiredBotIds) {
      if (!spawnIds.has(botId)) errors.push(`Encounter ${encounter.id} references missing bot ${botId}.`);
      else if (!botSpawnIds.has(botId)) errors.push(`Encounter ${encounter.id} cannot use player spawn ${botId}.`);
      if (assignedBots.has(botId)) errors.push(`Bot ${botId} is required by more than one encounter.`);
      assignedBots.add(botId);
    }
    if (encounter.requiredBotIds.length === 0) warnings.push(`Encounter ${encounter.id} has no required bots.`);
  }
  for (const spawn of level.spawns) {
    if (spawn.encounterId && !encounterIds.has(spawn.encounterId)) errors.push(`Spawn ${spawn.id} references missing encounter ${spawn.encounterId}.`);
    if (spawn.kind !== 'player' && spawn.encounterId && !level.encounters.find((item) => item.id === spawn.encounterId)?.requiredBotIds.includes(spawn.id)) {
      warnings.push(`Spawn ${spawn.id} is assigned to ${spawn.encounterId} but is not required by it.`);
    }
  }
  for (const primitive of level.collision) {
    if (primitive.gateForEncounterId && !encounterIds.has(primitive.gateForEncounterId)) {
      errors.push(`Gate ${primitive.id} references missing encounter ${primitive.gateForEncounterId}.`);
    }
  }
  for (const visual of level.visuals) {
    if (!isAssetId(visual.assetId)) errors.push(`Visual ${visual.id} references unknown catalog asset ${visual.assetId}.`);
    if (visual.collisionAlignmentId && !collisionIds.has(visual.collisionAlignmentId)) {
      errors.push(`Visual ${visual.id} references missing collision ${visual.collisionAlignmentId}.`);
    }
    if (visual.gateVisibilityBindingId && !encounterIds.has(visual.gateVisibilityBindingId)) {
      errors.push(`Visual ${visual.id} references missing gate binding ${visual.gateVisibilityBindingId}.`);
    }
  }
  for (const light of level.lights) {
    if (light.gateVisibilityBindingId && !encounterIds.has(light.gateVisibilityBindingId)) {
      errors.push(`Light ${light.id} references missing gate binding ${light.gateVisibilityBindingId}.`);
    }
    if (light.castShadow) warnings.push(`Light ${light.id} requests a shadow; accent lights are intentionally non-shadowed.`);
  }
  for (const hint of level.vistaHints) {
    // Beyond the clamp the simulation applies to pitch, a hint can never be reached and
    // the nudge would spend the whole zone pulling at its own ceiling.
    if (Math.abs(hint.pitch) > 1.48) errors.push(`Vista hint ${hint.id} asks for a pitch outside the look clamp.`);
  }
  if (level.collision.length === 0) warnings.push('The level has no geometry.');
  return { errors, warnings };
}
