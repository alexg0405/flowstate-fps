/**
 * What a tower in the skyline is, before any of it becomes geometry.
 *
 * The city used to be one `RoundedBoxGeometry(1, 1, 1)` instanced 180 times with a
 * different `scale` each. Every building was therefore the same building: the only
 * things that varied were how tall and how wide the box was, so a skyline of 180
 * towers read as one shape repeated. Windows compounded it -- they were placed on a
 * single inward-facing wall, so the other three faces of every tower were bare.
 *
 * This module owns the two decisions that fix that, and it is pure so both can be
 * tested without a WebGL context, the way `ResolutionController` and
 * `visualBatching` are:
 *
 * - **Silhouette.** A tower is a stack of blocks in normalised space. Six archetypes
 *   give six genuinely different masses -- setbacks, overhanging crowns, podiums,
 *   twinned shafts, ziggurats -- and each becomes one merged geometry, so the cost
 *   is one draw call per archetype rather than per building.
 * - **Facade.** The same block list tells the pane placer where the wall actually is
 *   at a given height, so windows follow a setback in instead of floating off the
 *   side of it. Four patterns decide how those panes are laid out.
 */

/**
 * One mass of a tower, in fractions of the tower's own bounding box.
 *
 * `y0`/`y1` run 0 at the base to 1 at the nominal top. `width`/`depth` are fractions
 * of the footprint and may exceed 1, which is how a crown overhangs its shaft.
 * `offsetX`/`offsetZ` shift the block off centre, which is how a tower gets two
 * shafts or a fin down one edge.
 */
export interface TowerBlock {
  y0: number;
  y1: number;
  width: number;
  depth: number;
  offsetX?: number;
  offsetZ?: number;
}

export interface TowerArchetype {
  id: string;
  blocks: readonly TowerBlock[];
}

/**
 * Six masses. The first block of each is the main one -- the pane placer reads the
 * block spanning a given height, so the order within an archetype does not matter,
 * but every archetype must cover 0 to 1 without a gap or a facade lookup falls
 * through. `tests/citySkyline.test.ts` asserts exactly that.
 */
export const towerArchetypes: readonly TowerArchetype[] = [
  // A plain slab with a service housing on the roof. The baseline the city had.
  { id: 'slab', blocks: [
    { y0: 0, y1: 0.96, width: 1, depth: 1 },
    { y0: 0.96, y1: 1, width: 0.36, depth: 0.4, offsetX: 0.2, offsetZ: -0.16 },
  ] },
  // Steps in twice on the way up. The most recognisably a *building* of the six.
  { id: 'setback', blocks: [
    { y0: 0, y1: 0.5, width: 1, depth: 1 },
    { y0: 0.5, y1: 0.78, width: 0.76, depth: 0.78 },
    { y0: 0.78, y1: 0.97, width: 0.5, depth: 0.52 },
    { y0: 0.97, y1: 1, width: 0.16, depth: 0.16 },
  ] },
  // A slim shaft under a cap that overhangs it, then a penthouse on top.
  { id: 'crowned', blocks: [
    { y0: 0, y1: 0.84, width: 0.84, depth: 0.84 },
    { y0: 0.84, y1: 0.9, width: 1, depth: 1 },
    { y0: 0.9, y1: 1, width: 0.44, depth: 0.46 },
  ] },
  // A wide podium with a tower rising out of it, and a plant deck at the top.
  { id: 'podium', blocks: [
    { y0: 0, y1: 0.15, width: 1, depth: 1 },
    { y0: 0.15, y1: 0.94, width: 0.6, depth: 0.64 },
    { y0: 0.94, y1: 1, width: 0.74, depth: 0.78 },
  ] },
  // Two shafts of different heights off one base, which gives the skyline a notch.
  { id: 'twin', blocks: [
    { y0: 0, y1: 0.28, width: 1, depth: 1 },
    { y0: 0.28, y1: 1, width: 0.38, depth: 0.88, offsetX: -0.3 },
    { y0: 0.28, y1: 0.84, width: 0.38, depth: 0.88, offsetX: 0.3 },
  ] },
  // A ziggurat. Four steps and a mast stub, for the back of the far tier.
  { id: 'stepped', blocks: [
    { y0: 0, y1: 0.38, width: 1, depth: 1 },
    { y0: 0.38, y1: 0.62, width: 0.82, depth: 0.82 },
    { y0: 0.62, y1: 0.82, width: 0.62, depth: 0.62 },
    { y0: 0.82, y1: 0.95, width: 0.4, depth: 0.4 },
    { y0: 0.95, y1: 1, width: 0.14, depth: 0.14 },
  ] },
];

/**
 * Building tones.
 *
 * Every tower used to be `#0a0f16`, which is very nearly the sky at zenith. That is
 * why the windows read as lights floating in the dark rather than as a lit facade:
 * there was no mass behind them for the eye to attach them to. These are still dark
 * -- the value hierarchy in AUDIT.md section 11 stands, and the emissive trim is
 * still what carries brightness -- but they separate from the sky, and they differ
 * from each other, so a wall of towers stops being one wall.
 *
 * Carried as an instance colour, so all six archetypes still share one material.
 */
export const towerTones: readonly string[] = [
  '#151d27', // pale concrete
  '#101822', // dark concrete
  '#0d151d', // glass curtain wall
  '#1a1f26', // weathered stone
  '#121b1f', // green-grey panel
  '#191821', // brown-grey brick
];

/**
 * How a facade is lit.
 *
 * A uniform grid on every tower is the other half of why the old skyline read as one
 * building: real cities mix floorplate types, and the lighting pattern is what tells
 * them apart at distance.
 */
export type FacadePattern = 'grid' | 'ribbon' | 'stack' | 'sparse';

export const facadePatterns: readonly FacadePattern[] = ['grid', 'ribbon', 'stack', 'sparse'];

/** Which mass of the tower sits at height fraction `t`, clamped to the ends. */
export function facadeAt(blocks: readonly TowerBlock[], t: number): TowerBlock {
  const height = Math.min(0.999_999, Math.max(0, t));
  for (const block of blocks) if (height >= block.y0 && height < block.y1) return block;
  // Only reachable for a malformed archetype; the largest block is the safe guess.
  return blocks.reduce((widest, block) => (block.width > widest.width ? block : widest), blocks[0]);
}

export interface PaneLayout {
  columns: number;
  rows: number;
  /** Pane size as a fraction of one cell, so a ribbon reads as a continuous band. */
  fillWidth: number;
  fillHeight: number;
  /** Chance a given pane is lit. A facade with every pane lit reads as a light box. */
  litChance: number;
}

/**
 * How one facade lays its panes out.
 *
 * `budget` is how many instances this face may spend, and the layout never asks for
 * more than that -- the pane meshes are sized from the same number, so overrunning
 * it would silently drop the last towers' windows.
 */
export function paneLayout(pattern: FacadePattern, budget: number, faceWidth: number, height: number): PaneLayout {
  const bounded = (columns: number, rows: number): [number, number] => {
    const safeColumns = Math.max(1, Math.min(columns, budget));
    return [safeColumns, Math.max(1, Math.min(rows, Math.floor(budget / safeColumns)))];
  };
  switch (pattern) {
    case 'ribbon': {
      // Continuous horizontal bands: one pane per storey, spanning the facade.
      const [columns, rows] = bounded(1, Math.floor(height / 4.2));
      return { columns, rows, fillWidth: 0.88, fillHeight: 0.3, litChance: 0.86 };
    }
    case 'stack': {
      // Narrow vertical strips running most of the height.
      const [columns, rows] = bounded(Math.round(faceWidth / 1.7), Math.floor(height / 7));
      return { columns, rows, fillWidth: 0.3, fillHeight: 0.84, litChance: 0.7 };
    }
    case 'sparse': {
      // A wide grid mostly dark, which is what an office block looks like at 2 a.m.
      const [columns, rows] = bounded(Math.round(faceWidth / 3.4), Math.floor(height / 5.4));
      return { columns, rows, fillWidth: 0.5, fillHeight: 0.36, litChance: 0.34 };
    }
    default: {
      const [columns, rows] = bounded(Math.round(faceWidth / 2.4), Math.floor(height / 3.4));
      return { columns, rows, fillWidth: 0.48, fillHeight: 0.42, litChance: 0.78 };
    }
  }
}
