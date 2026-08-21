/**
 * Painting the art direction into the geometry.
 *
 * The reference for this look is a city of enormous geometric masses whose faces are
 * *decided* rather than lit: one dark teal side, one pale cyan side, one magenta-lit side,
 * one black shadow side. That is not a lighting result. A renderer asked to produce it
 * would need four lights per building placed by hand, and it would still lose the read the
 * moment the camera moved.
 *
 * Vertex colour is how the industry does this without a texture budget: colour straight on
 * the mesh, three channels of gradient, no memory cost, and widely used to bake world
 * lighting on platforms with no lightmaps. Here it is not baked lighting -- it is a
 * *statement about which way a face points*, multiplied over whatever light the surface
 * then receives, so the graphic identity survives the sun moving and the player running
 * past with a muzzle flash.
 *
 * Applied to both the generated skyline and the catalogued route art, at two different
 * hardnesses. A stack of boxes wants the four faces to be four flat decisions with a hard
 * edge between them, because that edge *is* the composition. Authored art has smoothed
 * normals around its bevels and curves, and a hard rule there puts a seam in the middle of
 * a surface -- so it gets a blend that is still nearly flat on a flat face and eases across
 * anything that is not. `FACE_BLEND` is the one number separating the two cases.
 */

export type Rgb = readonly [number, number, number];

/**
 * What each face of a mass is worth, as a multiplier on its own colour.
 *
 * The two horizontal axes are deliberately asymmetric -- this is the whole trick. A box
 * lit evenly reads as a box; a box whose four sides are four different decisions reads as
 * architecture. Up is pale and cool because the sky over this route is; down is nearly
 * nothing, because a face nobody can see is a face worth spending on the silhouette.
 */
export const FACE_TINT: Record<'up' | 'down' | 'east' | 'west' | 'north' | 'south', Rgb> = {
  up: [1.02, 1.08, 1.16],
  down: [0.14, 0.18, 0.24],
  /** The pale cyan side. */
  east: [0.94, 1.06, 1.1],
  /** The dark teal side. */
  west: [0.36, 0.5, 0.52],
  /** The magenta-lit side, facing back down the route. */
  north: [1.12, 0.74, 0.88],
  /** And the one in shadow. */
  south: [0.24, 0.28, 0.36],
};

/**
 * How hard the boundary between two faces is.
 *
 * The exponent each axis component is raised to before the six tints are weighted by it.
 * High is effectively the dominant axis and nothing else; low eases across the boundary.
 * Both are the same function, which is why generated and authored geometry can be painted
 * by one code path without either looking like a compromise.
 */
export const FACE_BLEND = {
  /** A stack of boxes. The edge between two faces is a decision and should look like one. */
  mass: 16,
  /** Authored art, where a hard rule would seam a bevel it was never meant to describe. */
  authored: 4,
} as const;

/** Which face a normal belongs to. Dominant axis, with no blending: that is the point. */
export function faceOf(x: number, y: number, z: number): keyof typeof FACE_TINT {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ay >= ax && ay >= az) return y >= 0 ? 'up' : 'down';
  if (ax >= az) return x >= 0 ? 'east' : 'west';
  return z >= 0 ? 'north' : 'south';
}

export function faceTint(x: number, y: number, z: number): Rgb {
  return FACE_TINT[faceOf(x, y, z)];
}

/**
 * Per-vertex colours for a geometry's normals, ready for a `color` attribute.
 *
 * Flat by construction: every vertex of a face shares that face's normal in this kind of
 * geometry, so every vertex of a face gets the same tint and the boundary between two
 * faces is a hard edge rather than a gradient. That hard edge is the composition.
 */
export function paintByFacing(normals: ArrayLike<number>, hardness: number = FACE_BLEND.mass): Float32Array {
  const colours = new Float32Array(normals.length);
  for (let index = 0; index < normals.length; index += 3) {
    const tint = blendedTint(normals[index], normals[index + 1], normals[index + 2], hardness);
    colours[index] = tint[0];
    colours[index + 1] = tint[1];
    colours[index + 2] = tint[2];
  }
  return colours;
}

/**
 * The six tints, weighted by how much the normal points at each of them.
 *
 * At `FACE_BLEND.mass` this is the dominant axis to within a rounding error -- an
 * axis-aligned normal weights its own face at one and every other at zero -- so the hard
 * case and the soft case are genuinely the same function rather than two that have to be
 * kept in agreement.
 */
function blendedTint(x: number, y: number, z: number, hardness: number): Rgb {
  const weights: [keyof typeof FACE_TINT, number][] = [
    ['east', Math.max(0, x)], ['west', Math.max(0, -x)],
    ['up', Math.max(0, y)], ['down', Math.max(0, -y)],
    ['north', Math.max(0, z)], ['south', Math.max(0, -z)],
  ];
  let total = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [face, weight] of weights) {
    if (weight <= 0) continue;
    const scaled = weight ** hardness;
    total += scaled;
    r += FACE_TINT[face][0] * scaled;
    g += FACE_TINT[face][1] * scaled;
    b += FACE_TINT[face][2] * scaled;
  }
  // A degenerate normal has no face to belong to; leaving it unpainted beats blacking it.
  if (total <= 0) return [1, 1, 1];
  return [r / total, g / total, b / total];
}
