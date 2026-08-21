/**
 * The one curve between the lit scene and the screen.
 *
 * What this replaces: `ACESFilmicToneMapping` at an exposure of 0.52, followed by a grade
 * pass that pushed saturation back up by 1.22 and re-applied its own contrast curve. ACES
 * is a *film* curve -- its whole job is to take a physically lit scene and roll it off the
 * way a camera would, which means desaturating and compressing exactly the pure primaries
 * this game's palette is built from -- and the grade downstream of it was spending most of
 * its budget undoing that. The comment it left behind recorded the collision without
 * naming it: moving the grade after tone mapping "washes the whole route out", which is
 * two curves disagreeing about where the mid tones are.
 *
 * So there is one curve now, it is authored rather than photographic, and it has three
 * properties the photographic one could not have:
 *
 * - **Black is black.** No toe, and a small black point subtracted after exposure. A film
 *   curve is designed never to let a surface go to nothing; this look needs walls that
 *   collapse into near-nothing, with a turquoise puddle and a pink sign left in the frame.
 * - **The shoulder is on luminance, not per channel.** A per-channel roll-off desaturates
 *   as it compresses, which is precisely what took the colour out of the neon. Scaling the
 *   whole triple by the ratio the luminance was compressed by leaves hue and saturation
 *   exactly where the lighting put them.
 * - **It is linear underneath the knee.** Everything below `KNEE` passes through
 *   untouched, so mid tones are the values the materials and lights actually produced.
 *
 * `applyToneCurve` is a TypeScript mirror of `toneCurveGlsl`, not the shipped path -- the
 * shipped path is the shader. It exists so the curve's properties can be asserted in a
 * test rather than argued about over a screenshot, which is the only kind of guard
 * available for a renderer that needs WebGL to construct. Change one, change the other.
 */

export const TONE = {
  /**
   * Scene exposure. Lower than it looks like it should be because nothing is rolling the
   * top off any more until `KNEE`: with ACES gone, the same scene arrives about a stop
   * and a half brighter.
   */
  exposure: 0.34,
  /** Subtracted after exposure, which is what lets a dark surface reach zero. */
  blackPoint: 0.006,
  /** Where the shoulder starts. Everything under this is linear. */
  knee: 0.72,
  /** Applied about luminance, so it cannot push a channel out of gamut on its own. */
  saturation: 1.12,
  /** Rec. 709 luminance weights. */
  luma: [0.2126, 0.7152, 0.0722] as const,
  /**
   * The palette split: cool into the shadows, warm into the highlights. Much gentler
   * than the pair this replaces, because it is no longer compensating for a film curve
   * -- it is stating the palette the interface is built from.
   */
  shadowTint: [0.82, 0.94, 1.1] as const,
  highlightTint: [1.08, 1.03, 0.86] as const,
} as const;

type Rgb = readonly [number, number, number];

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The curve, in TypeScript. Mirrors `toneCurveGlsl` line for line; see the file header
 * for why both exist.
 */
export function applyToneCurve(colour: Rgb): [number, number, number] {
  const luma = (c: Rgb) => c[0] * TONE.luma[0] + c[1] * TONE.luma[1] + c[2] * TONE.luma[2];
  let out: [number, number, number] = [
    Math.max(0, colour[0] * TONE.exposure - TONE.blackPoint),
    Math.max(0, colour[1] * TONE.exposure - TONE.blackPoint),
    Math.max(0, colour[2] * TONE.exposure - TONE.blackPoint),
  ];
  const split = smoothstep(0.18, 0.82, luma(out));
  out = out.map((channel, index) => channel * (TONE.shadowTint[index] + (TONE.highlightTint[index] - TONE.shadowTint[index]) * split)) as [number, number, number];
  const level = luma(out);
  const rolled = level <= TONE.knee
    ? level
    : TONE.knee + (1 - TONE.knee) * (1 - Math.exp(-(level - TONE.knee) / (1 - TONE.knee)));
  const scale = rolled / Math.max(level, 1e-5);
  out = out.map((channel) => channel * scale) as [number, number, number];
  const grey = luma(out);
  return out.map((channel) => Math.min(1, Math.max(0, grey + (channel - grey) * TONE.saturation))) as [number, number, number];
}

const vec3 = (values: Rgb) => `vec3(${values.map((value) => value.toFixed(4)).join(',')})`;

/**
 * The shipped curve. Injected into the grade pass rather than into `renderer.toneMapping`,
 * because the grade already runs on the linear buffer and folding the two together is what
 * makes this *one* curve instead of two.
 */
export const toneCurveGlsl = `
  const vec3 LUMA = ${vec3(TONE.luma)};
  vec3 flowstateTone(vec3 c){
    // Exposure and the black point. Subtracting rather than lifting is the whole
    // difference between a graphic black and a photographic one.
    c = max(vec3(0.0), c * ${TONE.exposure.toFixed(4)} - ${TONE.blackPoint.toFixed(4)});
    // The palette, stated once.
    float split = smoothstep(0.18, 0.82, dot(c, LUMA));
    c *= mix(${vec3(TONE.shadowTint)}, ${vec3(TONE.highlightTint)}, split);
    // The shoulder, on luminance. Scaling the triple by the ratio luminance was
    // compressed by is what leaves a saturated primary saturated on the way out.
    float level = dot(c, LUMA);
    float knee = ${TONE.knee.toFixed(4)};
    float rolled = level <= knee ? level : knee + (1.0 - knee) * (1.0 - exp(-(level - knee) / (1.0 - knee)));
    c *= rolled / max(level, 1e-5);
    // And saturation about luma, which cannot push a channel out of gamut by itself.
    c = mix(vec3(dot(c, LUMA)), c, ${TONE.saturation.toFixed(4)});
    return clamp(c, 0.0, 1.0);
  }
`;
