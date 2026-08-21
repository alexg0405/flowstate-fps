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


/**
 * Where the towers stand -- and why that is a decision rather than a scatter.
 *
 * The placement used to be `z: 56 - random() * 300` inside `WorldPresenter`, ninety-six
 * near-tier towers, half to each side. Forty-eight towers over three hundred metres is one
 * every 6.25 m, and they are 7 to 16 m wide, so every one of them overlapped its
 * neighbours. The near tier was not a row of buildings; it was a continuous wall.
 *
 * Measured on a regenerated GPU baseline, that wall is **55% of the upper frame below
 * luminance 10**, and it is the reason nothing else in the look can matter: an art
 * direction built on near-black masses silhouetted against a bright sky has no sky to
 * silhouette against. Lifting the sky gradient moved the frame mean by zero because the
 * dome reaches almost no pixels.
 *
 * AUDIT section 11 added this tier for a real reason -- the upper half of the frame was
 * empty sky and the corridor felt unclosed -- and the fix overshot. What was wanted was a
 * city with buildings in it. What was built was a fence.
 *
 * So towers go on a jittered lattice with deliberate voids instead. A lattice guarantees
 * spacing that random placement only averages, and `voidChance` turns spacing into
 * *gaps* -- which is the only thing that puts sky back in the upper frame without
 * shortening the buildings, and shortening them is what would cost the scale.
 */
export interface TowerTier {
  count: number;
  minX: number;
  spreadX: number;
  minHeight: number;
  spreadHeight: number;
  minWidth: number;
  spreadWidth: number;
  panes: number;
  shapes: readonly number[];
  /** Fraction of lattice slots deliberately left empty. This is what makes sky. */
  voidChance: number;
  /**
   * Whether this is the tier close enough to carry screens and billboards.
   *
   * Authored rather than derived. It used to be `tier.minX < 40`, which is the kind of
   * threshold that works until someone moves a tier -- and moving the near tier from 29 m
   * to 52 m for the sky is exactly that. It silently turned the flag off and took the
   * billboards with it, and only a test about gap spacing noticed.
   */
  near: boolean;
}

export interface TowerPlan {
  archetype: number;
  tone: number;
  side: number;
  x: number;
  z: number;
  yaw: number;
  width: number;
  depth: number;
  height: number;
  pattern: FacadePattern;
  panes: number;
  near: boolean;
}

/**
 * Plans every tower before anything is allocated, because an `InstancedMesh` needs its
 * count up front.
 *
 * Deterministic in `random`, so the same seed is the same city -- which the pinned clock
 * in `visualRegression` depends on, and which is also what makes the openness test below
 * meaningful rather than a sample of one roll of the dice.
 */
export function planTowers(
  tiers: readonly TowerTier[],
  random: () => number,
  span: { from: number; to: number },
): TowerPlan[] {
  const plans: TowerPlan[] = [];
  const length = span.from - span.to;
  for (const tier of tiers) {
    const perSide = Math.ceil(tier.count / 2);
    const pitch = length / perSide;
    for (const side of [1, -1]) {
      for (let slot = 0; slot < perSide; slot += 1) {
        if (random() < tier.voidChance) continue;
        // Jittered off the lattice by up to a third of the pitch, so the row reads as a
        // street rather than as a fence, without ever closing a gap it just opened.
        const jitter = (random() - 0.5) * pitch * 0.66;
        plans.push({
          archetype: tier.shapes[Math.floor(random() * tier.shapes.length) % tier.shapes.length],
          tone: Math.floor(random() * towerTones.length) % towerTones.length,
          side,
          width: tier.minWidth + random() * tier.spreadWidth,
          depth: tier.minWidth + random() * tier.spreadWidth,
          height: tier.minHeight + random() * tier.spreadHeight,
          x: side * (tier.minX + random() * tier.spreadX),
          z: span.from - (slot + 0.5) * pitch + jitter,
          // Small: enough to break the axis alignment, not enough to read as rubble.
          yaw: (random() - 0.5) * 0.34,
          pattern: facadePatterns[Math.floor(random() * facadePatterns.length) % facadePatterns.length],
          panes: tier.panes,
          near: tier.near,
        });
      }
    }
  }
  return plans;
}

/**
 * Roughly what fraction of the frame above the horizon a camera on the route can still see
 * sky through.
 *
 * Not a renderer -- an angular occlusion test. Each tower subtends a wedge of azimuth and
 * reaches a crown elevation; a sample is blocked if it falls inside the wedge and below the
 * crown. Towers are treated as circular in plan at their widest, which at the planned yaw
 * of under twenty degrees is close enough to settle a question about tens of percent.
 *
 * The first version of this was wrong in a way worth recording, because it measured
 * *nothing* while looking like it measured something: it solved for where a ray crossed
 * each tower's `x` and tested the `z` there, which for a ray a degree off the corridor axis
 * lands hundreds of metres past the city. Dense and sparse placements both scored 0.78. It
 * was only caught by comparing against a control -- a solid wall of ninety-six towers --
 * and noticing the control scored the same. An estimator with no control is a number with
 * no meaning.
 *
 * The GPU baseline is still what confirms an absolute value. This is what stops a blind
 * guess being committed first.
 */
export function skyOpenness(
  plans: readonly TowerPlan[],
  eye: { x: number; y: number; z: number },
  options: { azimuthSpan: number; elevationFrom: number; elevationTo: number; samples: number } = {
    // Roughly the frame a 92-degree vertical FOV shows at 16:9, above the horizon.
    azimuthSpan: (122 * Math.PI) / 180, elevationFrom: 0.05, elevationTo: (46 * Math.PI) / 180, samples: 56,
  },
): number {
  interface Wedge { centre: number; half: number; crown: number }
  const wedges: Wedge[] = [];
  for (const plan of plans) {
    const dx = plan.x - eye.x;
    const dz = plan.z - eye.z;
    // Looking down -Z, so anything at a greater z is behind the camera.
    if (dz >= 0) continue;
    const distance = Math.hypot(dx, dz);
    if (distance < 1) continue;
    wedges.push({
      centre: Math.atan2(dx, -dz),
      half: Math.atan(Math.max(plan.width, plan.depth) / 2 / distance),
      // `baseY` in the renderer is `height / 2 - 18`, so a crown sits at `height - 18`.
      crown: Math.atan2(plan.height - 18 - eye.y, distance),
    });
  }

  let open = 0;
  let total = 0;
  for (let a = 0; a < options.samples; a += 1) {
    const azimuth = -options.azimuthSpan / 2 + (a / (options.samples - 1)) * options.azimuthSpan;
    for (let e = 0; e < options.samples; e += 1) {
      const elevation = options.elevationFrom + (e / (options.samples - 1)) * (options.elevationTo - options.elevationFrom);
      total += 1;
      if (!wedges.some((wedge) => Math.abs(azimuth - wedge.centre) < wedge.half && elevation < wedge.crown)) open += 1;
    }
  }
  return open / total;
}

/** How far down -Z the city runs, and where it starts. */
export const CITY_SPAN = { from: 56, to: -244 } as const;

/**
 * The two tiers, and the numbers the measurement changed.
 *
 * **Read the retraction at the bottom of this comment before trusting the sweep.**
 *
 * These numbers came off a sweep against `skyOpenness`, not off an intuition, and the
 * sweep overturned the intuition. Openness of the frame above the horizon, seeded
 * identically, against the placement being replaced:
 *
 *     control: 96 near, no voids (the old city)   180 towers   0.442
 *     60 near, 34% voids                          110 towers   0.420
 *     near minX 29 -> 52                           110 towers   0.471
 *     near minX 52 + 50% voids                     101 towers   0.457
 *     near minX 52 + 50% voids + far minX 80       101 towers   0.538
 *
 * **Thinning the city barely opens the sky. Moving it away does.** Cutting the near tier
 * from 96 towers to 60 with a third of the slots empty made the frame very slightly
 * *worse*, because occlusion is angular and angular size is distance: the nearest ring
 * dominates, and there are still plenty of towers in it. The two levers that actually
 * moved the number were `minX` on each tier -- and the far tier's, at 62 to 80, was the
 * single biggest one, worth more than every void put together.
 *
 * ## And then the GPU said no
 *
 * `minX` 52 and 80 were committed on that sweep and regenerated on a real frame. The
 * result: upper-frame mean luminance 20.5 to **18.8**, and the share below luminance 10
 * went 53% to **56%**. Slightly worse, for the cost of a 43 m dead band beside the route.
 * Reverted to 29 and 62.
 *
 * The estimator was not lying, it was incomplete, and the gap is the whole answer. It
 * models the two tower tiers and nothing else. What actually fills the upper frame is the
 * **overhead gantries** in `buildCity` -- beams at y 40 to 84, spanning 80 to 200 m across
 * the route, one every 24 m down it. From an eye at 1.5 m those sit between 28 and 58
 * degrees of elevation across the full width of the frame. They are a ceiling.
 *
 * They are also deliberate: AUDIT section 11 added them "so the upper half of the frame is
 * not empty sky", and they do precisely that. So the reason this route has no sky is a
 * previous fix working as designed, and the lever is `gantryCount` and their `y`, not the
 * tiers and not the gradient. That is a decision about whether the corridor should feel
 * roofed, which is worth making on purpose rather than by tuning around it.
 *
 * What survives from the sweep: the placement is a lattice with voids rather than uniform
 * random, so towers no longer overlap their neighbours at 6.25 m spacing, and the numbers
 * measure neutral against the old city (0.420 against 0.442) for two thirds of the towers.
 */
export const CITY_TIERS: readonly TowerTier[] = [
  {
    count: 60, minX: 29, spreadX: 32, minHeight: 20, spreadHeight: 52,
    minWidth: 7, spreadWidth: 9, panes: 34, shapes: [0, 0, 1, 1, 2, 5], voidChance: 0.34, near: true,
  },
  {
    count: 84, minX: 62, spreadX: 128, minHeight: 34, spreadHeight: 130,
    minWidth: 10, spreadWidth: 20, panes: 58, shapes: [0, 1, 2, 3, 4, 5], voidChance: 0.22, near: false,
  },
];
