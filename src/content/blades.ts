import type { BladeStyleDefinition, BladeStyleId } from '../contracts';
import { palette } from '../render/palette';

/**
 * Three blades, and what separates them is the chain rather than the damage.
 *
 * The gun bench is four chassis and five part slots, which is a stat game and the right
 * shape for a secondary: fit a drum, lose reload speed, see the bar move. Running the
 * same machinery for the primary verb would have produced two stat games and no reason to
 * prefer either. So a blade is *chosen*, not assembled, and what the choice buys is a
 * different rule for how a chain is built:
 *
 * - **Tempo** is the default and the reference. It keeps the chain open nearly twice as
 *   long, which is the traversal player's blade: a chain that survives a grapple across a
 *   gap is a chain that pays for using the movement kit between fights.
 * - **Cleave** pays two links a kill. It is the aggressive blade -- kills are the only
 *   repeatable link in the game, so doubling them is the only way to grow a chain without
 *   reaching for a different tool, and it costs reach, speed and the shortest window.
 * - **Riposte** pays two links a perfect dodge and adds the most to the multiplier. It is
 *   the defensive blade, and the one that asks the most: a dodge links once per chain, so
 *   the payoff is front-loaded and the rest has to come from the kit.
 *
 * Every number here is measured against the same baseline the melee tuning was, and the
 * baseline itself is not a free choice. Judging reach in first person, with no visible arm
 * and no visible blade, is genuinely hard -- it is the risk this whole pivot turns on, and
 * a swing that misses because the player read two metres as three teaches nothing.
 * Ghostrunner's answer is a generous envelope plus assist, so Tempo's light reaches 3.6 m
 * through a 130-degree cone and kills a hundred-health hunter in two. Riposte trades some
 * of that envelope away for recovery, and that trade is the *only* thing a style is
 * allowed to do to it: none of them may shorten reach far enough to bring the depth
 * problem back, and none of them may make the bulwark a damage problem.
 */
export const bladeStyles: readonly BladeStyleDefinition[] = [
  {
    id: 'tempo',
    label: 'Tempo',
    description: 'The reference blade. Balanced reach and recovery.',
    chainNote: 'Chains stay open far longer, so movement between fights still pays.',
    light: { seconds: 0.24, range: 3.6, arcCosine: Math.cos(1.13), damage: 65 },
    heavy: { seconds: 0.46, range: 4.2, arcCosine: Math.cos(1.4), damage: 130, shieldFloor: 0.5 },
    chain: { killLinks: 1, dodgeLinks: 1, windowBonusSeconds: 2, linkStepBonus: 0 },
    accent: palette.yellowHot,
  },
  {
    id: 'cleave',
    label: 'Cleave',
    description: 'Heavier and slower, and it takes a wider bite.',
    chainNote: 'Every kill is worth two links, which is the only link that repeats.',
    light: { seconds: 0.3, range: 3.4, arcCosine: Math.cos(1.2), damage: 82 },
    heavy: { seconds: 0.54, range: 4.4, arcCosine: Math.cos(1.5), damage: 165, shieldFloor: 0.5 },
    chain: { killLinks: 2, dodgeLinks: 1, windowBonusSeconds: 0, linkStepBonus: 0 },
    accent: palette.red,
  },
  {
    id: 'riposte',
    label: 'Riposte',
    description: 'Quick and short. Trades reach and weight for recovery.',
    chainNote: 'A perfect dodge is worth two links, and every link is worth more.',
    light: { seconds: 0.19, range: 3.3, arcCosine: Math.cos(1.05), damage: 52 },
    heavy: { seconds: 0.38, range: 3.8, arcCosine: Math.cos(1.32), damage: 104, shieldFloor: 0.5 },
    chain: { killLinks: 1, dodgeLinks: 2, windowBonusSeconds: 0.6, linkStepBonus: 0.05 },
    accent: palette.cyan,
  },
];

export const defaultBladeStyle: BladeStyleId = 'tempo';

/** The style with this id, or the default. A stale save must not break a run. */
export function bladeStyle(id: string | undefined): BladeStyleDefinition {
  return bladeStyles.find((style) => style.id === id) ?? bladeStyles[0];
}

export function isBladeStyleId(value: unknown): value is BladeStyleId {
  return typeof value === 'string' && bladeStyles.some((style) => style.id === value);
}
