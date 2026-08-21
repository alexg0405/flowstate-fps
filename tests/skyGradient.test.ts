import { describe, expect, it } from 'vitest';
import { relativeLuminance, skyFragmentShader, skyLuminanceAt, SKY_BANDS, SKY_STOPS } from '../src/render/presentation/skyGradient';
import { vistaCones } from '../src/content/vistaBlockout';
import { defaultLevel } from '../src/content/defaultLevel';

/**
 * Measured off `tests/e2e/visual.spec.ts-snapshots/white-line-vx09-high-chromium.png`,
 * which is a real GPU frame: the deck averages a relative luminance of 37 and the sky in
 * the slot averages 20 to 25. That is the value inversion this file exists to close.
 *
 * These are *rendered* numbers and the constants below are *raw* uniforms, so the two are
 * not directly comparable -- the frame still goes through the authored tone curve. What
 * is comparable is the deck's own raw albedo, `#2b3743` from `MaterialLibrary`, against
 * the sky's raw stops. If the sky loses on raw values it cannot possibly win on rendered
 * ones.
 */
const DECK_ALBEDO = [0x2b, 0x37, 0x43] as const;
const DECK_RAW_LUMA = relativeLuminance(DECK_ALBEDO);

/** Elevation of a normalised direction at a given pitch, which is just its sine. */
const elevationAt = (pitchRadians: number) => Math.sin(pitchRadians);

describe('the sky is brighter than the floor', () => {
  it('beats the deck at every elevation a camera on this route looks at', () => {
    // The authored cones plus White Line's hints, which is every angle the game
    // deliberately points the player at.
    const pitches = [
      ...vistaCones.map((cone) => cone.pitch),
      ...defaultLevel.vistaHints.map((hint) => hint.pitch),
    ];
    expect(pitches.length).toBeGreaterThan(4);
    for (const pitch of pitches) {
      const luma = skyLuminanceAt(elevationAt(pitch));
      expect(luma, `sky at ${((pitch * 180) / Math.PI).toFixed(0)} degrees`).toBeGreaterThan(DECK_RAW_LUMA);
    }
  });

  it('beats it in the band a corridor actually leaves visible', () => {
    // A seven-metre wall nine metres away hides everything below `atan(7/9)`, so the
    // visible slot on White Line runs from about h = 0.62 to the zenith. That band was
    // luma 12 to 21 before this change, against a deck of 53 raw.
    for (let h = 0.62; h <= 1; h += 0.04) {
      expect(skyLuminanceAt(h), `h=${h.toFixed(2)}`).toBeGreaterThan(DECK_RAW_LUMA);
    }
  });

  it('keeps the zenith the darkest part of the sky, so it still reads as sky', () => {
    // Brighter is not the goal; a *gradient* that is brighter is. A flat bright dome
    // would take the depth out of the frame entirely.
    expect(skyLuminanceAt(1)).toBeLessThan(skyLuminanceAt(0.5));
    expect(skyLuminanceAt(0.5)).toBeLessThan(skyLuminanceAt(0.05));
  });

  it('leaves the hot horizon band alone, because it was never the problem', () => {
    expect(SKY_STOPS.horizon.hex).toBe('#ec6a72');
    expect(relativeLuminance(SKY_STOPS.horizon.rgb)).toBeGreaterThan(120);
  });

  it('widens the horizon band to the elevation a corridor wall subtends', () => {
    // 0.28 put the hot band under the wall line on every part of this route.
    expect(SKY_BANDS.horizonBand[1]).toBeGreaterThan(0.5);
    expect(SKY_BANDS.horizonBand[1]).toBeCloseTo(Math.sin(Math.atan(7 / 9)), 1);
  });
});

describe('the shader and the constants cannot drift apart', () => {
  const shader = skyFragmentShader();

  it('is built from the authored bands', () => {
    expect(shader).toContain(`smoothstep(${SKY_BANDS.horizonBand[0]},${SKY_BANDS.horizonBand[1]},h)`);
    expect(shader).toContain(`smoothstep(${SKY_BANDS.duskBand[0]},${SKY_BANDS.duskBand[1]},h)`);
    expect(shader).toContain(`smoothstep(${SKY_BANDS.nadirBand[0]},${SKY_BANDS.nadirBand[1]},h)`);
  });

  it('declares every uniform it is given, and no others', () => {
    for (const name of Object.keys(SKY_STOPS)) expect(shader).toContain(`uniform vec3 ${name};`);
    expect(shader.match(/uniform vec3/g)).toHaveLength(Object.keys(SKY_STOPS).length);
  });

  it('still writes an opaque colour, because it is the backdrop', () => {
    expect(shader).toContain('gl_FragColor=vec4(c,1.);');
  });
});
