import type { RunModifier, WeaponChassisId } from '../contracts';
import { hashSeed } from '../simulation/random';

/**
 * Daily run modifiers. Each one is a reason to come back tomorrow and a reason to
 * bring a particular build, which the armory otherwise never rewards: every chassis
 * is playable on every route, so nothing made any of them the right answer.
 *
 * Bonuses are additive fractions applied to the score a run earns, so a modifier can
 * never make a run worth less than an unmodified one.
 */
export const runModifiers: readonly RunModifier[] = [
  {
    id: 'close-quarters',
    label: 'Close Quarters',
    description: 'Hostiles push in close and hit harder. Kills with a shotgun or an SMG score double.',
    favouredChassis: ['shotgun', 'smg'],
    chassisBonus: 1,
    linkBonus: 0,
    enemy: { moveSpeed: 1.15, damage: 1.2, preferredRange: 0.75 },
  },
  {
    id: 'long-lines',
    label: 'Long Lines',
    description: 'Hostiles hold their distance and give you less warning before they fire. Kills with a DMR or a carbine score double.',
    favouredChassis: ['dmr', 'carbine'],
    chassisBonus: 1,
    linkBonus: 0,
    enemy: { preferredRange: 1.4, windupSeconds: 0.8, baseSpread: 0.8 },
  },
  {
    id: 'flow-state',
    label: 'Momentum',
    description: 'Hostiles are quicker on the trigger. Every link in a movement chain scores triple.',
    favouredChassis: [],
    chassisBonus: 0,
    linkBonus: 2,
    enemy: { fireInterval: 0.8 },
  },
  {
    id: 'glass',
    label: 'Glass Cannon',
    description: 'Hostiles go down easier and hit half again as hard. Everything you score is worth half again.',
    favouredChassis: [],
    chassisBonus: 0,
    linkBonus: 0.5,
    runBonus: 0.5,
    enemy: { damage: 1.5, health: 0.8 },
  },
];

/**
 * The modifier for a given day, chosen from the date so every player on a given day
 * races the same rules. Local date on purpose: a daily should turn over at the
 * player's midnight, not at UTC's.
 */
export function modifierForDate(date: Date): RunModifier {
  const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  return runModifiers[hashSeed(key) % runModifiers.length];
}

export function getRunModifier(id: string): RunModifier | undefined {
  return runModifiers.find((modifier) => modifier.id === id);
}

/** Multiplier a modifier applies to score earned with the given chassis. */
export function chassisMultiplier(modifier: RunModifier | null, chassisId: WeaponChassisId): number {
  if (!modifier || !modifier.favouredChassis.includes(chassisId)) return 1;
  return 1 + modifier.chassisBonus;
}
