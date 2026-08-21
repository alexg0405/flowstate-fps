import { audioMix, defaultSave, runScoring } from '../content/config';
import { getRunModifier } from '../content/modifiers';
import { defaultBladeStyle, isBladeStyleId } from '../content/blades';
import { defaultArmory, getWeaponChassis, getWeaponPart, weaponPartSlots } from '../content/weapons';
import type {
  GhostTrack,
  RunRank,
  RunRecord,
  RunSplit,
  SaveData,
  SaveDataV6,
  SaveSettingsV2,
  SaveSettingsV3,
  WeaponBuild,
  WeaponChassisId,
  WeaponPartSlot,
} from '../contracts';

// Keep the established storage namespace so existing installations and browser
// tests find their data. The serialized payload itself is now schemaVersion 6.
const SAVE_KEY = 'flowstate-fps-save-v1';

const RANKS: readonly RunRank[] = ['S', 'A', 'B', 'C'];

const GRAPHICS_QUALITIES = new Set<SaveSettingsV2['graphicsQuality']>(['auto', 'low', 'medium', 'high']);

export function loadSave(): SaveDataV6 {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return saveDefaults();
    return migrateSaveData(JSON.parse(raw));
  } catch {
    return saveDefaults();
  }
}

export function migrateSaveData(input: unknown): SaveDataV6 {
  const defaults = saveDefaults();
  const version = isRecord(input) ? input.schemaVersion : undefined;
  if (!isRecord(input) || typeof version !== 'number' || version < 1 || version > 6) return defaults;

  const settings = isRecord(input.settings) ? input.settings : {};
  const quality = GRAPHICS_QUALITIES.has(settings.graphicsQuality as SaveSettingsV2['graphicsQuality'])
    ? settings.graphicsQuality as SaveSettingsV2['graphicsQuality']
    : defaults.settings.graphicsQuality;

  // V1 and V2 saves predate the armory, so they inherit the seeded builds.
  const armory = sanitizeArmory(input.armory) ?? defaults.armory;
  return {
    schemaVersion: 6,
    armory,
    loadout: sanitizeLoadout(input.loadout, armory),
    // Saves before V5 predate the blade being a choice, so they inherit the reference
    // style rather than losing their run history to a field they could not have had.
    blade: isBladeStyleId(input.blade) ? input.blade : defaultBladeStyle,
    bestRun: sanitizeRecord(input.bestRun) ?? legacyRecord(input),
    settings: {
      sensitivity: numberOr(settings.sensitivity, defaults.settings.sensitivity),
      fov: numberOr(settings.fov, defaults.settings.fov),
      cameraRoll: numberOr(settings.cameraRoll, defaults.settings.cameraRoll),
      headBob: numberOr(settings.headBob, defaults.settings.headBob),
      shake: numberOr(settings.shake, defaults.settings.shake),
      renderScale: numberOr(settings.renderScale, defaults.settings.renderScale),
      debug: booleanOr(settings.debug, defaults.settings.debug),
      reducedMotion: booleanOr(settings.reducedMotion, defaults.settings.reducedMotion),
      graphicsQuality: quality,
      dynamicResolution: booleanOr(settings.dynamicResolution, defaults.settings.dynamicResolution),
      // Clamped rather than trusted: a hand-edited save with a volume of 40 would
      // hand the bus a gain of 40, and the limiter is glue, not protection.
      volume: clamp01(numberOr(settings.volume, defaults.settings.volume)),
    },
    bestTimeSeconds: typeof input.bestTimeSeconds === 'number' && Number.isFinite(input.bestTimeSeconds)
      ? input.bestTimeSeconds
      : defaults.bestTimeSeconds,
  };
}

function sanitizeRecord(value: unknown): RunRecord | null {
  if (!isRecord(value)) return null;
  const timeSeconds = numberOr(value.timeSeconds, Number.NaN);
  const score = numberOr(value.score, Number.NaN);
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(score)) return null;
  return {
    timeSeconds,
    score,
    rank: RANKS.includes(value.rank as RunRank) ? value.rank as RunRank : 'C',
    deaths: Math.max(0, Math.round(numberOr(value.deaths, 0))),
    peakCombo: Math.max(0, Math.round(numberOr(value.peakCombo, 0))),
    splits: sanitizeSplits(value.splits),
    ...sanitizeGhost(value.ghost),
    ...(typeof value.modifierId === 'string' && getRunModifier(value.modifierId)
      ? { modifierId: value.modifierId }
      : {}),
  };
}

/**
 * Spreadable, so a record with no stored path simply has no `ghost` key rather than
 * an explicit undefined that would serialize differently.
 */
function sanitizeGhost(value: unknown): { ghost?: GhostTrack } {
  if (!isRecord(value) || typeof value.levelId !== 'string' || !Array.isArray(value.samples)) return {};
  const intervalSeconds = numberOr(value.intervalSeconds, Number.NaN);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return {};
  // Triples only: a trailing partial sample would be read as a position.
  const usable = Math.floor(value.samples.length / 3) * 3;
  const samples: number[] = [];
  for (let index = 0; index < usable; index += 1) {
    const entry = value.samples[index];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return {};
    samples.push(Math.round(entry));
  }
  if (samples.length === 0) return {};
  return { ghost: { levelId: value.levelId, intervalSeconds, samples } };
}

function sanitizeSplits(value: unknown): readonly RunSplit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.encounterId !== 'string') return [];
    const seconds = numberOr(entry.seconds, Number.NaN);
    if (!Number.isFinite(seconds)) return [];
    return [{
      encounterId: entry.encounterId,
      label: typeof entry.label === 'string' && entry.label ? entry.label : entry.encounterId,
      seconds,
    }];
  });
}

/**
 * V1 to V3 stored best time, best score and rank independently, so they could each
 * come from a different attempt. The best available reconstruction is to treat them
 * as one run; from here on a record is only ever written whole.
 */
function legacyRecord(input: Record<string, unknown>): RunRecord | null {
  const score = numberOr(input.bestScore, 0);
  const timeSeconds = typeof input.bestTimeSeconds === 'number' && Number.isFinite(input.bestTimeSeconds)
    ? input.bestTimeSeconds
    : null;
  if (timeSeconds === null && score <= 0) return null;
  return {
    timeSeconds: timeSeconds ?? runScoring.parSeconds,
    score,
    rank: RANKS.includes(input.rank as RunRank) ? input.rank as RunRank : 'C',
    deaths: 0,
    // Chains predate this schema, so a legacy record has nothing to report.
    peakCombo: 0,
    splits: [],
  };
}

function sanitizeArmory(value: unknown): WeaponBuild[] | null {
  if (!Array.isArray(value)) return null;
  const builds = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !getWeaponChassis(String(entry.chassisId))) return [];
    const parts: Partial<Record<WeaponPartSlot, string>> = {};
    const source = isRecord(entry.parts) ? entry.parts : {};
    for (const slot of weaponPartSlots) {
      const partId = source[slot];
      // Drop parts that no longer exist or have moved slot rather than failing the load.
      if (typeof partId === 'string' && getWeaponPart(partId)?.slot === slot) parts[slot] = partId;
    }
    return [{
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : 'Build',
      chassisId: entry.chassisId as WeaponChassisId,
      parts,
    }];
  });
  return builds.length > 0 ? builds : null;
}

function sanitizeLoadout(value: unknown, armory: readonly WeaponBuild[]): readonly [string, string] {
  const fallback = armory[0]?.id ?? '';
  const ids = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const resolve = (index: number): string => {
    const candidate = ids[index];
    if (candidate && armory.some((build) => build.id === candidate)) return candidate;
    return armory[Math.min(index, armory.length - 1)]?.id ?? fallback;
  };
  return [resolve(0), resolve(1)];
}

/** The two builds carried into a run, in slot order. */
export function loadoutBuilds(save: SaveDataV6): WeaponBuild[] {
  return save.loadout.map((id) => save.armory.find((build) => build.id === id) ?? save.armory[0]).filter(Boolean);
}

function saveDefaults(): SaveDataV6 {
  const legacy = structuredClone(defaultSave);
  const settings: SaveSettingsV3 = {
    ...legacy.settings,
    graphicsQuality: 'auto',
    dynamicResolution: true,
    volume: audioMix.defaultVolume,
  };
  if (typeof matchMedia === 'function') settings.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const armory = defaultArmory();
  return {
    schemaVersion: 6,
    settings,
    bestRun: null,
    bestTimeSeconds: legacy.bestTimeSeconds,
    armory,
    loadout: [armory[0].id, armory[1].id],
    blade: defaultBladeStyle,
  };
}

export function writeSave(save: SaveData): void {
  localStorage.setItem(SAVE_KEY, JSON.stringify(migrateSaveData(save)));
}

/**
 * Grades a run against the par time and its death count. The old curve derived rank
 * from the all-time best score, and since every clear scores at least 1050 against
 * an S threshold of 900, it awarded S to anyone who finished.
 */
export function rankRun(elapsedSeconds: number, deaths: number, peakCombo = 0): RunRank {
  for (const tier of runScoring.ranks) {
    if (
      elapsedSeconds <= runScoring.parSeconds * tier.parMultiple
      && deaths <= tier.maxDeaths
      // The chain gate is what stops the top grade being reachable by simply
      // walking the route quickly and never touching the movement kit.
      && peakCombo >= tier.minPeakCombo
    ) return tier.rank;
  }
  return 'C';
}

export interface RecordedRun {
  save: SaveDataV6;
  run: RunRecord;
  /** The record this run was measured against, or null on a first clear. */
  previousBest: RunRecord | null;
  isBestRun: boolean;
  isFastest: boolean;
}

export function recordRun(
  save: SaveData,
  elapsedSeconds: number,
  score: number,
  deaths = 0,
  splits: readonly RunSplit[] = [],
  peakCombo = 0,
  ghost?: GhostTrack,
  modifierId?: string,
): RecordedRun {
  const current = migrateSaveData(save);
  const previousBest = current.bestRun;
  const run: RunRecord = {
    timeSeconds: elapsedSeconds,
    score,
    rank: rankRun(elapsedSeconds, deaths, peakCombo),
    deaths,
    peakCombo,
    splits: [...splits],
    ...(ghost ? { ghost } : {}),
    ...(modifierId ? { modifierId } : {}),
  };
  // Score is the composite metric -- it already folds in kills, encounters and the
  // time bonus -- so it decides the record. A faster run that scored less is still
  // tracked, but as the explicitly separate `bestTimeSeconds`.
  const isBestRun = previousBest === null || run.score > previousBest.score;
  const isFastest = current.bestTimeSeconds === null || elapsedSeconds < current.bestTimeSeconds;
  const next: SaveDataV6 = {
    ...current,
    bestRun: isBestRun ? run : previousBest,
    bestTimeSeconds: isFastest ? elapsedSeconds : current.bestTimeSeconds,
  };
  writeSave(next);
  return { save: next, run, previousBest, isBestRun, isFastest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
