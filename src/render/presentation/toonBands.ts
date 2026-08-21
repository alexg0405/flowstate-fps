/**
 * Quantised light, and the colour a surface turns as it leaves it.
 *
 * The reference for doing this in a shipping 3D game is Guilty Gear Xrd, and the lesson is
 * not "use a toon shader" -- it is that the *inputs* to lighting were authored as art. The
 * two decisions this module owns are the two that matter:
 *
 * **How many steps.** Three or four broad zones rather than a continuous ramp, with the
 * count varying by material. Architecture gets few, because it has to read as a plane;
 * characters get more, because they need volume and because combat readability is sacred
 * in a game that also wants walls collapsing into near-black. Emissive trim gets almost
 * none: it is a colour, not a surface.
 *
 * **What colour the dark end is.** Painters have had a word for this for five hundred
 * years -- *cangiante*, where a surface changes hue as it turns away from the light rather
 * than merely getting darker. A renderer's default is a grey shadow; this look wants a
 * cyan wall whose unlit face is blue-green, which is a decision and not a physical fact.
 *
 * Both fall out of one texture. `three.js` reads a toon material's gradient map as a
 * multiplier on incoming light, so a *coloured* ramp with soft steps in it carries the
 * band count and the shadow hue together, and the whole system is one `DataTexture` per
 * profile plus a one-line shader patch (see `cangianteGradient`).
 *
 * Everything here is pure so it can be asserted rather than screenshotted, which is the
 * precedent `ResolutionController`, `visualBatching`, `citySkyline` and `hitstop` all set:
 * `GameRenderer` needs WebGL to construct, so anything left inside it cannot be tested.
 */

export type Rgb = readonly [number, number, number];

export interface BandProfile {
  /**
   * Steps the light is divided into, including both ends. Two is a hard light/dark
   * split; one is flat and unlit-looking.
   */
  bands: number;
  /**
   * How wide each step's border is, in fractions of a band. Zero is a hard staircase --
   * the obvious anime band this look is trying not to be -- and the values below are
   * deliberately small but non-zero.
   */
  softness: number;
  /** What the light is multiplied by at the dark end. The hue an unlit face turns. */
  shadow: Rgb;
  /** And at the lit end. Slightly under one, so nothing is lit to bare white. */
  light: Rgb;
  /**
   * Edge light, and the readability budget this whole module is spending.
   *
   * A world of flat masses and near-black shadow will swallow a figure standing in it,
   * and the usual answer -- an outline around everything that can be shot -- is the one
   * thing the reference this look is drawn from does not have: shapes there separate
   * through value and colour, not contour. So figures get a thin edge in the room's own
   * hue instead, which reads as light catching them rather than as an overlay.
   *
   * Zero for anything that is not a figure. Architecture separating itself from
   * architecture is what the band count is for.
   */
  rim: number;
  /** The hue that edge takes. */
  rimColour: Rgb;
  /**
   * Lowest luminance this kind of thing's own colour is allowed to be, before any light
   * touches it.
   *
   * This is the Guilty Gear Xrd lesson stated as a number: the inputs to lighting are
   * art. The authored hunter GLBs are near-black by design -- dark armour with a glowing
   * stripe, which is the right call and was readable when an environment probe was
   * filling them in. With the probe gone and the world reduced to flat masses, a figure
   * at that albedo is a hole in the frame however many bands it shades in. Lifting it
   * here preserves the hue and costs nothing at runtime.
   *
   * Zero for architecture, which is allowed -- required, even -- to collapse into
   * near-nothing.
   */
  albedoFloor: number;
}

export type BandProfileId = 'architecture' | 'prop' | 'character' | 'skin' | 'glass' | 'emissive' | 'viewmodel';

/**
 * The band table.
 *
 * Shadow hues are all cool and none of them are grey: the route is a cyan-and-magenta
 * city, so a face turning away from the light turns blue-green rather than dark. Skin is
 * the one exception -- it turns violet, because a cool green shadow on a face reads as
 * illness rather than as light.
 */
export const bandProfiles: Record<BandProfileId, BandProfile> = {
  /** The route itself. Few steps, because a wall should read as one plane. */
  architecture: { bands: 3, softness: 0.16, shadow: [0.16, 0.26, 0.34], light: [1, 0.99, 0.94], rim: 0, rimColour: [0, 0, 0], albedoFloor: 0 },
  /** Crates, rails, anything the player runs past rather than looks at. */
  prop: { bands: 3, softness: 0.2, shadow: [0.18, 0.28, 0.36], light: [1, 1, 0.97], rim: 0.04, rimColour: [0.18, 0.55, 0.66], albedoFloor: 0.04 },
  /**
   * Hostiles, and the reason they get five where a wall gets three. An enemy has to hold
   * its volume against an environment that is deliberately flat, or the world swallows it.
   */
  character: { bands: 5, softness: 0.3, shadow: [0.3, 0.4, 0.56], light: [1, 0.99, 0.96], rim: 1.3, rimColour: [0.2, 0.78, 0.92], albedoFloor: 0.2 },
  skin: { bands: 5, softness: 0.42, shadow: [0.46, 0.34, 0.5], light: [1, 0.97, 0.93], rim: 0.5, rimColour: [0.72, 0.44, 0.62], albedoFloor: 0.22 },
  /** Four, and the darkest end is the brightest of any profile: glass is never solid. */
  glass: { bands: 4, softness: 0.22, shadow: [0.3, 0.48, 0.6], light: [1, 1, 1], rim: 0.16, rimColour: [0.4, 0.9, 1], albedoFloor: 0.08 },
  /** Signal trim. It is a colour rather than a surface, so it barely shades at all. */
  emissive: { bands: 2, softness: 0.5, shadow: [0.62, 0.72, 0.8], light: [1, 1, 1], rim: 0, rimColour: [0, 0, 0], albedoFloor: 0 },
  /**
   * What is in the player's hands, on its own light rig. One step more than the world so
   * the weapon holds its form against whatever it is being held in front of.
   */
  viewmodel: { bands: 4, softness: 0.26, shadow: [0.24, 0.32, 0.44], light: [1, 1, 0.98], rim: 0.3, rimColour: [0.42, 0.72, 0.9], albedoFloor: 0.1 },
};

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Where a surface facing `t` lands on the ramp, 0 fully turned away and 1 fully lit.
 *
 * A sum of soft steps, one per band boundary, which is monotonic by construction and
 * hits exactly 0 and 1 at the ends -- both of which matter, because a ramp that dipped
 * would make a surface get brighter as it turned away, and one that never reached 1
 * would mean nothing in the game is ever fully lit.
 */
export function bandLevel(t: number, profile: BandProfile): number {
  const bands = Math.max(1, Math.round(profile.bands));
  if (bands <= 1) return 1;
  const scaled = Math.min(1, Math.max(0, t)) * bands;
  const width = Math.max(0, profile.softness) * 0.5;
  let level = 0;
  for (let boundary = 1; boundary < bands; boundary += 1) {
    level += smoothstep(boundary - width, boundary + width, scaled);
  }
  return Math.min(1, level / (bands - 1));
}

/**
 * A colour raised to a profile's albedo floor, with its hue intact.
 *
 * Scaling the whole triple rather than lifting each channel is the difference between a
 * dark red staying red and turning pink: adding a constant washes a saturated colour out,
 * multiplying does not. A colour that is already bright enough is returned unchanged, and
 * a colour that is exactly black cannot be scaled anywhere, so it is lifted to a neutral
 * at the floor rather than left as a hole.
 */
export function liftAlbedo(colour: Rgb, floor: number): [number, number, number] {
  if (floor <= 0) return [colour[0], colour[1], colour[2]];
  const level = colour[0] * 0.2126 + colour[1] * 0.7152 + colour[2] * 0.0722;
  if (level >= floor) return [colour[0], colour[1], colour[2]];
  if (level <= 1e-5) return [floor, floor, floor];
  const scale = floor / level;
  return [Math.min(1, colour[0] * scale), Math.min(1, colour[1] * scale), Math.min(1, colour[2] * scale)];
}

/** The colour the light is multiplied by at `t`. */
export function bandColour(t: number, profile: BandProfile): [number, number, number] {
  const level = bandLevel(t, profile);
  return [0, 1, 2].map((channel) => profile.shadow[channel] + (profile.light[channel] - profile.shadow[channel]) * level) as [number, number, number];
}

/**
 * The ramp as texture bytes, RGBA, ready for a `DataTexture`.
 *
 * Linear rather than sRGB on purpose: this is a multiplier on incoming light, not a
 * colour anyone looks at, and encoding it would bend every band boundary.
 */
export function bandTexture(profile: BandProfile, size = 64): Uint8Array {
  const pixels = new Uint8Array(size * 4);
  for (let index = 0; index < size; index += 1) {
    const colour = bandColour(index / (size - 1), profile);
    pixels[index * 4] = Math.round(Math.min(1, colour[0]) * 255);
    pixels[index * 4 + 1] = Math.round(Math.min(1, colour[1]) * 255);
    pixels[index * 4 + 2] = Math.round(Math.min(1, colour[2]) * 255);
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

/**
 * The one-line patch that makes any of this colour rather than value.
 *
 * `three.js` reads a toon material's gradient map as `vec3( texture2D( gradientMap, coord
 * ).r )` -- the red channel, broadcast to grey -- so a coloured ramp would be silently
 * flattened to its red channel and the whole shadow-hue half of this module would do
 * nothing. Reading `.rgb` instead is the entire change.
 *
 * Exported as a pair rather than applied here so the call site can assert the
 * substitution actually happened: `onBeforeCompile` runs before includes are resolved, so
 * the target is the include directive, and a `three.js` upgrade that renamed it would
 * otherwise fail completely silently.
 */
export const cangianteGradient = {
  find: '#include <gradientmap_pars_fragment>',
  replace: `
    #ifdef USE_GRADIENTMAP
      uniform sampler2D gradientMap;
    #endif
    vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
      float dotNL = dot( normal, lightDirection );
      vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
      #ifdef USE_GRADIENTMAP
        return texture2D( gradientMap, coord ).rgb;
      #else
        vec2 fw = fwidth( coord ) * 0.5;
        return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
      #endif
    }
  `,
} as const;

/**
 * The edge light, added to the outgoing colour rather than to the lighting.
 *
 * It targets the one line of the toon shader that is not a chunk include, which is what
 * makes it survivable: `onBeforeCompile` runs before includes are resolved, so a chunk
 * name is a moving target and this line is not.
 */
export const rimLight = {
  declare: {
    find: 'uniform float opacity;',
    replace: 'uniform float opacity;\nuniform vec3 flowRimColour;\nuniform float flowRimStrength;',
  },
  apply: {
    find: 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
    replace: `
      float flowFacing = 1.0 - clamp( dot( normalize( vViewPosition ), normal ), 0.0, 1.0 );
      vec3 flowRim = flowRimColour * flowRimStrength * pow( flowFacing, 2.6 );
      vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance + flowRim;
    `,
  },
} as const;
