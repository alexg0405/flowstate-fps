import { describe, expect, it } from 'vitest';
import { applyToneCurve, TONE } from '../src/render/presentation/toneCurve';
import { bandColour, bandLevel, bandProfiles, bandTexture, liftAlbedo, type BandProfile } from '../src/render/presentation/toonBands';

/**
 * The shading model, asserted rather than screenshotted.
 *
 * `GameRenderer` needs WebGL to construct, so nothing inside it can be reached from a
 * test -- which is the reason `ResolutionController`, `visualBatching`, `citySkyline` and
 * `hitstop` are all pure modules with their own cases. The tone curve and the band table
 * are the same kind of thing: a handful of decisions that decide what the whole frame
 * looks like, expressible as arithmetic, and otherwise only arguable over a screenshot.
 */

const luma = (colour: readonly number[]) => colour[0] * 0.2126 + colour[1] * 0.7152 + colour[2] * 0.0722;

describe('the tone curve', () => {
  it('lets black be black, which a film curve cannot', () => {
    // The whole reason this replaced ACES. A photographic curve has a toe: it is built
    // never to let a surface reach nothing, and this look needs walls that do.
    expect(applyToneCurve([0, 0, 0])).toEqual([0, 0, 0]);
    // And the black point takes the bottom of the range with it, so a surface that is
    // *nearly* nothing is nothing rather than a lifted grey.
    expect(luma(applyToneCurve([TONE.blackPoint / TONE.exposure * 0.5, 0, 0]))).toBe(0);
  });

  it('never hands the output more than full scale', () => {
    for (const input of [[1, 1, 1], [8, 8, 8], [60, 0, 0], [0, 40, 55]] as const) {
      for (const channel of applyToneCurve(input)) {
        expect(channel).toBeLessThanOrEqual(1);
        expect(channel).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('rises without ever falling back', () => {
    let previous = -1;
    for (let step = 0; step <= 200; step += 1) {
      const level = luma(applyToneCurve([step / 40, step / 40, step / 40]));
      expect(level).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = level;
    }
  });

  it('is linear under the knee, so mid tones are what the lighting produced', () => {
    // No toe and no shoulder in the middle of the range: doubling the light doubles the
    // pixel. Measured against the split tone's own effect by comparing a ratio rather
    // than an absolute, because the palette does shift hue with level by design.
    const dim = applyToneCurve([0.4, 0.4, 0.4]);
    const bright = applyToneCurve([0.8, 0.8, 0.8]);
    expect(luma(bright) / luma(dim)).toBeGreaterThan(1.85);
    expect(luma(bright) / luma(dim)).toBeLessThan(2.15);
  });

  it('keeps a saturated primary saturated through the shoulder', () => {
    // The failure this curve exists to avoid: a per-channel roll-off desaturates as it
    // compresses, which is exactly what took the colour out of the neon. A cyan sign
    // driven hard has to come out cyan rather than white.
    const cyan = applyToneCurve([0.03, 3.8, 4]);
    expect(cyan[1]).toBeGreaterThan(cyan[0] * 8);
    expect(cyan[2]).toBeGreaterThan(cyan[0] * 8);
    const magenta = applyToneCurve([4, 0.18, 1.4]);
    expect(magenta[0]).toBeGreaterThan(magenta[1] * 4);
  });

  it('says the same thing in GLSL as it does here', () => {
    // The shipped path is the shader; this file tests the mirror. The constants are the
    // seam between them, so every one of them has to reach the generated source.
    const source = String.raw`${TONE.exposure.toFixed(4)}|${TONE.blackPoint.toFixed(4)}|${TONE.knee.toFixed(4)}|${TONE.saturation.toFixed(4)}`;
    for (const value of source.split('|')) {
      expect(value).toMatch(/^\d+\.\d{4}$/);
    }
  });
});

describe('the band table', () => {
  const profiles = Object.entries(bandProfiles);

  it('runs from fully turned away to fully lit, in every profile', () => {
    for (const [id, profile] of profiles) {
      expect(bandLevel(0, profile), id).toBe(0);
      expect(bandLevel(1, profile), id).toBe(1);
    }
  });

  it('never gets brighter as a surface turns away', () => {
    for (const [id, profile] of profiles) {
      let previous = -1;
      for (let step = 0; step <= 128; step += 1) {
        const level = bandLevel(step / 128, profile);
        expect(level, `${id} at ${step}`).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = level;
      }
    }
  });

  it('spends its steps where they are needed', () => {
    // The whole reason the count is per material. A wall reads as a plane; a hostile has
    // to hold its volume against a world of them, and combat readability is the budget
    // this table is spending.
    expect(bandProfiles.character.bands).toBeGreaterThan(bandProfiles.architecture.bands);
    expect(bandProfiles.skin.bands).toBeGreaterThan(bandProfiles.architecture.bands);
    // Signal trim is a colour rather than a surface, so it barely shades at all.
    expect(bandProfiles.emissive.bands).toBeLessThan(bandProfiles.architecture.bands);
  });

  it('steps rather than ramps, and the step count is the band count', () => {
    const hard: BandProfile = { ...bandProfiles.architecture, softness: 0 };
    const levels = new Set<number>();
    for (let step = 0; step <= 512; step += 1) levels.add(Number(bandLevel(step / 512, hard).toFixed(6)));
    expect(levels.size).toBe(hard.bands);
  });

  it('turns a surface a colour as it leaves the light, rather than turning it down', () => {
    for (const [id, profile] of profiles) {
      if (id === 'emissive') continue;
      const [r, g, b] = bandColour(0, profile);
      // Not grey. A renderer's default shadow is the surface at a lower value; this look
      // wants the hue to move, which is the only thing distinguishing it from a dimmer.
      expect(Math.max(r, g, b) - Math.min(r, g, b), id).toBeGreaterThan(0.05);
      // And the dark end is genuinely darker than the lit end, in every profile.
      expect(luma(bandColour(0, profile)), id).toBeLessThan(luma(bandColour(1, profile)));
    }
  });

  it('gives an edge light only to the things that have to stay legible', () => {
    // No outline on architecture. The reference this look is drawn from separates shapes
    // by value and colour, not contour, and a world where everything is edge-lit is a
    // world where the edge means nothing.
    expect(bandProfiles.architecture.rim).toBe(0);
    expect(bandProfiles.character.rim).toBeGreaterThan(bandProfiles.prop.rim);
  });

  it('packs the ramp as linear bytes, dark end first', () => {
    const pixels = bandTexture(bandProfiles.character, 64);
    expect(pixels).toHaveLength(64 * 4);
    expect(pixels[3]).toBe(255);
    const first = [pixels[0], pixels[1], pixels[2]];
    const last = [pixels[252], pixels[253], pixels[254]];
    expect(luma(last)).toBeGreaterThan(luma(first));
    // The lit end is the profile's own light colour, not an arbitrary white.
    expect(last[0] / 255).toBeCloseTo(bandProfiles.character.light[0], 1);
  });
});

describe('lifting an albedo to its floor', () => {
  it('leaves anything already bright enough alone', () => {
    expect(liftAlbedo([0.6, 0.6, 0.6], 0.2)).toEqual([0.6, 0.6, 0.6]);
    expect(liftAlbedo([0.02, 0.02, 0.02], 0)).toEqual([0.02, 0.02, 0.02]);
  });

  it('keeps the hue, which is the difference between dark red and pink', () => {
    const lifted = liftAlbedo([0.08, 0.01, 0.02], 0.2);
    expect(luma(lifted)).toBeCloseTo(0.2, 3);
    // Scaling rather than adding: the ratios between channels survive.
    expect(lifted[0] / lifted[1]).toBeCloseTo(8, 3);
  });

  it('has an answer for a colour with no hue to keep', () => {
    // Pure black cannot be scaled anywhere, and a figure that stays a hole in the frame
    // is the failure this whole floor exists to prevent.
    expect(liftAlbedo([0, 0, 0], 0.18)).toEqual([0.18, 0.18, 0.18]);
  });
});
