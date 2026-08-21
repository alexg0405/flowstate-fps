/**
 * The sky, as four colours and two bands -- and as something that can be measured without
 * a GPU.
 *
 * The gradient used to live as a hex literal and a `smoothstep` inside a one-line
 * fragment shader string, which made it the one part of the art direction nothing could
 * check. That mattered more than it looks. Measured off the committed pixel baseline, the
 * sky in frame averages a relative luminance of about 21 while the deck averages 37: the
 * *floor* is the brightest large mass in a composition whose reference is enormous
 * near-black shapes against an enormous bright sky.
 *
 * The cause is not the colours. It is where they are put. `horizon` is genuinely bright,
 * and `smoothstep(0, 0.28, h)` confines it to the first sixteen degrees above horizontal
 * -- which on a route between seven-metre walls nine metres apart begins at
 * `atan(7 / 9)`, or `h = 0.62`, and is therefore never visible. Everything the player can
 * actually see is the `dusk`-to-`zenith` end, and that end was near-black.
 *
 * So the shader is generated from these constants rather than written beside them, and
 * `skyLuminanceAt` reimplements the same mix in TypeScript so a test can ask the question
 * that matters: across the elevations this game's cameras actually look at, is the sky
 * brighter than the deck? `tests/skyGradient.test.ts` holds that, and it is the only part
 * of the look currently verifiable in an environment with no working WebGL context.
 *
 * What it cannot tell you is the final pixel: these are raw uniform values and the frame
 * goes through the authored tone curve in `PostPipeline` afterwards. The baseline run
 * settles that -- see `tests/e2e/visual.spec.ts`.
 */

export interface SkyStop {
  hex: string;
  rgb: readonly [number, number, number];
}

function stop(hex: string): SkyStop {
  const value = Number.parseInt(hex.slice(1), 16);
  return { hex, rgb: [(value >> 16) & 255, (value >> 8) & 255, value & 255] };
}

/**
 * Four stops, top to bottom.
 *
 * `dusk` and `zenith` carry the change, because they are the two the player sees. They
 * were `#51244e` and `#080b1d` -- raw luminance 49 and 12 -- so the upper sky was darker
 * than the deck before the tone curve even ran. Lifted into the same violet-magenta
 * family rather than recoloured, so the palette is unchanged and only the value moves.
 *
 * `horizon` is untouched. It was never the problem; it was simply never on screen.
 */
export const SKY_STOPS = {
  zenith: stop('#3a3570'),
  dusk: stop('#7a3a72'),
  horizon: stop('#ec6a72'),
  nadir: stop('#070b13'),
} as const;

/**
 * Where each stop takes over, as `smoothstep` edges on the normalised elevation `h`.
 *
 * `horizonBand` is widened from `0.28` to `0.62`, which is exactly the elevation a
 * seven-metre wall nine metres away subtends. Below that number the hot band is
 * unreachable on this route; at it, the horizon colour reaches the bottom of the visible
 * slot instead of stopping just under it.
 */
export const SKY_BANDS = {
  horizonBand: [0, 0.62] as const,
  duskBand: [0.1, 0.88] as const,
  nadirBand: [0, -0.38] as const,
} as const;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Rec.709 relative luminance of an 8-bit triple, which is what "brighter" means here. */
export function relativeLuminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/**
 * The same mix the shader does, in TypeScript.
 *
 * `elevation` is the y of a normalised direction: 0 at the horizon, 1 at the zenith. Kept
 * deliberately as a transcription rather than a shared abstraction -- the shader is a
 * string and cannot import this, so the honest arrangement is one source of truth for the
 * *numbers* and a test that pins the *shape*.
 */
export function skyColourAt(elevation: number): [number, number, number] {
  const { zenith, dusk, horizon, nadir } = SKY_STOPS;
  if (elevation > 0) {
    const upper = mix(dusk.rgb, zenith.rgb, smoothstep(SKY_BANDS.duskBand[0], SKY_BANDS.duskBand[1], elevation));
    return mix(horizon.rgb, upper, smoothstep(SKY_BANDS.horizonBand[0], SKY_BANDS.horizonBand[1], elevation));
  }
  return mix(horizon.rgb, nadir.rgb, smoothstep(SKY_BANDS.nadirBand[0], SKY_BANDS.nadirBand[1], elevation));
}

export function skyLuminanceAt(elevation: number): number {
  return relativeLuminance(skyColourAt(elevation));
}

/** The fragment shader, built from the constants above so the two cannot drift apart. */
export function skyFragmentShader(): string {
  const { horizonBand, duskBand, nadirBand } = SKY_BANDS;
  return [
    'varying vec3 vWorld;',
    'uniform vec3 zenith;uniform vec3 dusk;uniform vec3 horizon;uniform vec3 nadir;',
    'void main(){',
    'float h=normalize(vWorld).y;',
    `vec3 upper=mix(dusk,zenith,smoothstep(${duskBand[0]},${duskBand[1]},h));`,
    `vec3 c=h>0.0?mix(horizon,upper,smoothstep(${horizonBand[0]},${horizonBand[1]},h))`,
    `:mix(horizon,nadir,smoothstep(${nadirBand[0]},${nadirBand[1]},h));`,
    'gl_FragColor=vec4(c,1.);}',
  ].join('');
}
