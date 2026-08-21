/**
 * The shapes combat is drawn with.
 *
 * What this replaces was a particle-and-glow vocabulary: an impact was a soft ring that
 * scaled up and faded, sparks were cones on ballistic arcs, and a muzzle flash was a glow
 * quad. All of it is the renderer describing a physical event -- expanding gas, hot
 * fragments, light falling off -- and all of it dissolves into the same additive haze at
 * a distance.
 *
 * This is the same events drawn as *graphics*: a flash is an angular star that exists for
 * two frames, an impact leaves a hard-edged fracture behind it, and debris is flat shards
 * rather than lit cones. Nothing here simulates anything. The shapes are irregular because
 * they are generated from a seed rather than because anything was integrated.
 *
 * Pure, so the geometry can be asserted -- vertex counts, radii, that a fracture is
 * actually irregular -- rather than eyeballed in a screenshot at forty metres.
 */

export interface FlatShape {
  /** Triangle-list positions in the XY plane, three floats per vertex. */
  positions: Float32Array;
  /** Furthest any vertex sits from the origin, for sizing the mesh that carries it. */
  radius: number;
}

/** A deterministic 0..1 from an integer. Presentation may be arbitrary, never random. */
function hashed(seed: number): number {
  const mixed = Math.imul(seed ^ 0x9e37_79b9, 0x85eb_ca6b) >>> 0;
  return (mixed % 100_000) / 100_000;
}

/**
 * A star, as a fan of triangles from the centre out to alternating radii.
 *
 * This is the muzzle flash and the first frame of an impact. Points are odd numbers on
 * purpose -- five, seven, nine -- because an even star reads as a symmetrical decoration
 * and an odd one reads as an event.
 */
export function starBurst(points: number, innerRatio: number, seed = 0): FlatShape {
  const spokes = Math.max(3, Math.round(points));
  const positions = new Float32Array(spokes * 2 * 9);
  let cursor = 0;
  let radius = 0;
  for (let index = 0; index < spokes * 2; index += 1) {
    const outer = index % 2 === 0;
    // Each spoke is jittered in length and angle, so a burst never repeats exactly and
    // a held trigger does not stamp the same star eight times.
    const jitter = 0.72 + hashed(seed * 31 + index) * 0.56;
    const spread = (Math.PI * 2) / (spokes * 2);
    const angle = index * spread + (hashed(seed * 17 + index) - 0.5) * spread * 0.5;
    const nextAngle = (index + 1) * spread + (hashed(seed * 17 + index + 1) - 0.5) * spread * 0.5;
    const nextJitter = 0.72 + hashed(seed * 31 + index + 1) * 0.56;
    const here = (outer ? 1 : innerRatio) * jitter;
    const there = (outer ? innerRatio : 1) * nextJitter;
    radius = Math.max(radius, here, there);
    positions[cursor++] = 0; positions[cursor++] = 0; positions[cursor++] = 0;
    positions[cursor++] = Math.cos(angle) * here; positions[cursor++] = Math.sin(angle) * here; positions[cursor++] = 0;
    positions[cursor++] = Math.cos(nextAngle) * there; positions[cursor++] = Math.sin(nextAngle) * there; positions[cursor++] = 0;
  }
  return { positions, radius };
}

/**
 * The dark shape a round leaves in a surface.
 *
 * An irregular polygon rather than a circle, and deliberately not symmetrical: this is
 * the "black triangular fracture" half of a graphic impact, drawn after the white flash
 * and outliving it. It is the one effect in the game that is *darker* than what is behind
 * it, which is only possible because it does not blend additively.
 */
export function fracture(points: number, seed = 0): FlatShape {
  const spokes = Math.max(3, Math.round(points));
  const positions = new Float32Array(spokes * 9);
  let cursor = 0;
  let radius = 0;
  const radii: number[] = [];
  const angles: number[] = [];
  for (let index = 0; index < spokes; index += 1) {
    const step = (Math.PI * 2) / spokes;
    radii.push(0.34 + hashed(seed * 53 + index) * 0.66);
    angles.push(index * step + (hashed(seed * 71 + index) - 0.5) * step * 0.7);
  }
  for (let index = 0; index < spokes; index += 1) {
    const next = (index + 1) % spokes;
    radius = Math.max(radius, radii[index]);
    positions[cursor++] = 0; positions[cursor++] = 0; positions[cursor++] = 0;
    positions[cursor++] = Math.cos(angles[index]) * radii[index]; positions[cursor++] = Math.sin(angles[index]) * radii[index]; positions[cursor++] = 0;
    positions[cursor++] = Math.cos(angles[next]) * radii[next]; positions[cursor++] = Math.sin(angles[next]) * radii[next]; positions[cursor++] = 0;
  }
  return { positions, radius };
}

/**
 * One flat sliver of debris. A triangle rather than a cone, because a cone is a lit solid
 * and this is a mark on the frame that happens to be moving.
 */
export function shard(seed = 0): FlatShape {
  const width = 0.24 + hashed(seed * 13) * 0.3;
  const length = 0.7 + hashed(seed * 29) * 0.6;
  const lean = (hashed(seed * 41) - 0.5) * 0.5;
  const positions = new Float32Array([
    0, -length * 0.35, 0,
    -width * 0.5 + lean, length * 0.65, 0,
    width * 0.5 + lean, length * 0.5, 0,
  ]);
  return { positions, radius: Math.max(width, length) };
}

/**
 * A ring with corners.
 *
 * The grapple and the checkpoint already announced themselves with a ring; at
 * twenty-eight segments it was a circle, which is the one shape this whole vocabulary
 * does not contain. Six is a hexagon and reads as drawn.
 */
export function angularRing(sides: number, innerRatio: number): FlatShape {
  const count = Math.max(3, Math.round(sides));
  const positions = new Float32Array(count * 18);
  let cursor = 0;
  const push = (angle: number, distance: number) => {
    positions[cursor++] = Math.cos(angle) * distance;
    positions[cursor++] = Math.sin(angle) * distance;
    positions[cursor++] = 0;
  };
  for (let index = 0; index < count; index += 1) {
    const step = (Math.PI * 2) / count;
    const here = index * step;
    const next = (index + 1) * step;
    push(here, innerRatio); push(here, 1); push(next, 1);
    push(here, innerRatio); push(next, 1); push(next, innerRatio);
  }
  return { positions, radius: 1 };
}
