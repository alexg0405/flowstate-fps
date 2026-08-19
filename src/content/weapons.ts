import type {
  WeaponBuild,
  WeaponChassisDefinition,
  WeaponChassisId,
  WeaponDefinition,
  WeaponPartDefinition,
  WeaponPartSlot,
} from '../contracts';

export const weaponPartSlots: readonly WeaponPartSlot[] = ['optic', 'barrel', 'magazine', 'grip', 'stock'];

/** Melee is a property of the operator, not the gun, so every chassis shares it. */
const MELEE = { meleeDamage: 70, meleeRange: 2.25 } as const;

export const weaponChassis: readonly WeaponChassisDefinition[] = [
  {
    id: 'carbine',
    label: 'Carbine',
    description: 'Balanced rate and reach. Forgiving at every range.',
    base: {
      ...MELEE,
      magazineSize: 30, reserveAmmo: 120, roundsPerMinute: 720, reloadSeconds: 1.55,
      damage: 34, headshotMultiplier: 1.75, range: 140, hipSpread: 0.018, adsSpread: 0.003,
      pellets: 1, adsZoom: 20,
      recoilPitch: 0.006, recoilYaw: 0.0022, recoilRecovery: 0.6,
      bloomPerShot: 0.09, bloomMax: 1.6, bloomRecovery: 2.2,
    },
  },
  {
    id: 'smg',
    label: 'SMG',
    description: 'Very high rate, low damage. Rewards staying close and moving.',
    base: {
      ...MELEE,
      magazineSize: 40, reserveAmmo: 180, roundsPerMinute: 1020, reloadSeconds: 1.3,
      damage: 20, headshotMultiplier: 1.4, range: 70, hipSpread: 0.034, adsSpread: 0.012,
      pellets: 1, adsZoom: 12,
      recoilPitch: 0.0045, recoilYaw: 0.0032, recoilRecovery: 0.7,
      bloomPerShot: 0.07, bloomMax: 2, bloomRecovery: 2.4,
    },
  },
  {
    id: 'shotgun',
    label: 'Shotgun',
    description: 'Eight pellets per shell. Devastating inside a few metres.',
    base: {
      ...MELEE,
      magazineSize: 6, reserveAmmo: 48, roundsPerMinute: 96, reloadSeconds: 2.4,
      damage: 13, headshotMultiplier: 1.25, range: 28, hipSpread: 0.085, adsSpread: 0.05,
      pellets: 8, adsZoom: 8,
      recoilPitch: 0.028, recoilYaw: 0.004, recoilRecovery: 0.9,
      bloomPerShot: 0.25, bloomMax: 1.2, bloomRecovery: 1.6,
    },
  },
  {
    id: 'dmr',
    label: 'DMR',
    description: 'Slow, precise and hard hitting, with the longest reach.',
    base: {
      ...MELEE,
      magazineSize: 12, reserveAmmo: 72, roundsPerMinute: 260, reloadSeconds: 1.9,
      damage: 62, headshotMultiplier: 2.2, range: 220, hipSpread: 0.012, adsSpread: 0.0008,
      pellets: 1, adsZoom: 32,
      recoilPitch: 0.017, recoilYaw: 0.0018, recoilRecovery: 0.8,
      bloomPerShot: 0.3, bloomMax: 1.4, bloomRecovery: 1.8,
    },
  },
];

export const weaponParts: readonly WeaponPartDefinition[] = [
  { id: 'optic.irons', slot: 'optic', label: 'Iron sights', description: 'No trade-offs, no help.', modifiers: {} },
  { id: 'optic.reflex', slot: 'optic', label: 'Reflex', description: 'Tighter aimed shots without extra zoom.', modifiers: { adsSpread: 0.72 } },
  { id: 'optic.scope', slot: 'optic', label: 'Scope', description: 'Much tighter and closer, at a slower rate of fire.', modifiers: { adsSpread: 0.45, adsZoom: 1.6, roundsPerMinute: 0.94 } },

  { id: 'barrel.standard', slot: 'barrel', label: 'Standard barrel', description: 'Factory length.', modifiers: {} },
  { id: 'barrel.short', slot: 'barrel', label: 'Short barrel', description: 'Snappier and steadier from the hip, but short ranged.', modifiers: { range: 0.68, hipSpread: 0.78, roundsPerMinute: 1.06, recoilRecovery: 1.15 } },
  { id: 'barrel.long', slot: 'barrel', label: 'Long barrel', description: 'Far more reach and damage, less steady unaimed and heavier in the hands.', modifiers: { range: 1.4, damage: 1.08, hipSpread: 1.18, roundsPerMinute: 0.94, recoilPitch: 1.18 } },
  { id: 'barrel.choke', slot: 'barrel', label: 'Choke', description: 'Tightens the pellet spread hard.', chassis: ['shotgun'], modifiers: { hipSpread: 0.55, adsSpread: 0.5, range: 1.25 } },

  { id: 'magazine.standard', slot: 'magazine', label: 'Standard magazine', description: 'Factory capacity.', modifiers: {} },
  { id: 'magazine.extended', slot: 'magazine', label: 'Extended magazine', description: 'Half again the rounds, slower to swap.', modifiers: { magazineSize: 1.5, reloadSeconds: 1.22 } },
  { id: 'magazine.drum', slot: 'magazine', label: 'Drum', description: 'Double capacity and deep reserves, very slow to swap.', modifiers: { magazineSize: 2, reserveAmmo: 1.25, reloadSeconds: 1.5 } },
  { id: 'magazine.quickfeed', slot: 'magazine', label: 'Quickfeed', description: 'Fast swaps from a smaller magazine.', modifiers: { magazineSize: 0.82, reloadSeconds: 0.66 } },

  { id: 'grip.standard', slot: 'grip', label: 'Standard grip', description: 'Factory grip.', modifiers: {} },
  { id: 'grip.vertical', slot: 'grip', label: 'Vertical grip', description: 'Steadier hip fire, and the climb stays vertical.', modifiers: { hipSpread: 0.76, recoilYaw: 0.62 } },
  { id: 'grip.angled', slot: 'grip', label: 'Angled grip', description: 'A little faster and a little tighter aimed, and quicker to settle.', modifiers: { adsSpread: 0.86, roundsPerMinute: 1.03, recoilRecovery: 1.2 } },

  { id: 'stock.standard', slot: 'stock', label: 'Standard stock', description: 'Factory stock.', modifiers: {} },
  { id: 'stock.heavy', slot: 'stock', label: 'Heavy stock', description: 'Kicks far less and holds its pattern, noticeably slower.', modifiers: { adsSpread: 0.66, hipSpread: 0.88, roundsPerMinute: 0.92, recoilPitch: 0.68, bloomPerShot: 0.78 } },
  { id: 'stock.light', slot: 'stock', label: 'Skeleton stock', description: 'Faster fire, and it climbs for it.', modifiers: { roundsPerMinute: 1.09, adsSpread: 1.2, hipSpread: 1.1, recoilPitch: 1.28, recoilYaw: 1.2 } },
];

/** Bounds keep any combination of parts inside a playable envelope. */
const STAT_LIMITS = {
  damage: [4, 140],
  roundsPerMinute: [60, 1400],
  reloadSeconds: [0.5, 4],
  range: [12, 320],
  hipSpread: [0.002, 0.16],
  adsSpread: [0.0004, 0.09],
  magazineSize: [2, 120],
  reserveAmmo: [12, 400],
  headshotMultiplier: [1, 3],
  adsZoom: [4, 46],
  // Kept inside a controllable envelope: parts may shape the climb, never remove it
  // and never make it unfightable.
  recoilPitch: [0.0015, 0.06],
  recoilYaw: [0.0004, 0.012],
  recoilRecovery: [0.25, 1.8],
  bloomPerShot: [0.02, 0.6],
  bloomMax: [0.4, 3],
  bloomRecovery: [0.8, 4],
} as const satisfies Record<string, readonly [number, number]>;

const INTEGER_STATS = new Set(['magazineSize', 'reserveAmmo', 'roundsPerMinute']);

export function getWeaponChassis(id: string): WeaponChassisDefinition | undefined {
  return weaponChassis.find((chassis) => chassis.id === id);
}

export function getWeaponPart(id: string): WeaponPartDefinition | undefined {
  return weaponParts.find((part) => part.id === id);
}

/** Parts that may be fitted to the given chassis in the given slot. */
export function partsForSlot(chassisId: WeaponChassisId, slot: WeaponPartSlot): readonly WeaponPartDefinition[] {
  return weaponParts.filter((part) => part.slot === slot && (!part.chassis || part.chassis.includes(chassisId)));
}

/**
 * Folds a build's parts into the chassis base stats. Unknown parts, parts fitted
 * to the wrong slot, and parts that do not fit the chassis are ignored rather
 * than throwing, so a stale saved build still produces a usable weapon.
 */
export function resolveWeaponStats(build: WeaponBuild): WeaponDefinition {
  const chassis = getWeaponChassis(build.chassisId) ?? weaponChassis[0];
  const resolved: Record<string, number> = { ...chassis.base };

  for (const [slot, partId] of Object.entries(build.parts)) {
    if (!partId) continue;
    const part = getWeaponPart(partId);
    if (!part || part.slot !== slot) continue;
    if (part.chassis && !part.chassis.includes(chassis.id)) continue;
    for (const [stat, multiplier] of Object.entries(part.modifiers)) {
      if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) continue;
      resolved[stat] = (resolved[stat] ?? 0) * multiplier;
    }
  }

  for (const [stat, [minimum, maximum]] of Object.entries(STAT_LIMITS)) {
    const value = resolved[stat];
    if (typeof value !== 'number') continue;
    const clamped = Math.min(maximum, Math.max(minimum, value));
    resolved[stat] = INTEGER_STATS.has(stat) ? Math.round(clamped) : clamped;
  }

  return resolved as unknown as WeaponDefinition;
}

export function defaultBuildFor(chassisId: WeaponChassisId, id: string, name: string): WeaponBuild {
  return {
    id,
    name,
    chassisId,
    parts: { optic: 'optic.irons', barrel: 'barrel.standard', magazine: 'magazine.standard', grip: 'grip.standard', stock: 'stock.standard' },
  };
}

/** Seeds a new save with one close-range and one long-range option. */
export function defaultArmory(): WeaponBuild[] {
  return [
    { ...defaultBuildFor('carbine', 'build-carbine', 'Carbine'), parts: { ...defaultBuildFor('carbine', '', '').parts, optic: 'optic.reflex' } },
    { ...defaultBuildFor('smg', 'build-smg', 'SMG'), parts: { ...defaultBuildFor('smg', '', '').parts, grip: 'grip.vertical' } },
  ];
}
