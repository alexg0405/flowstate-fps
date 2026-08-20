import { describe, expect, it } from 'vitest';
import { facadeAt, facadePatterns, paneLayout, towerArchetypes, towerTones } from '../src/render/presentation/citySkyline';

describe('tower archetypes', () => {
  it('gives the skyline more than one building', () => {
    // The whole point of the module: the city used to be one box scaled 180 ways.
    expect(towerArchetypes.length).toBeGreaterThan(3);
    expect(new Set(towerArchetypes.map((archetype) => archetype.id)).size).toBe(towerArchetypes.length);
  });

  it('covers the full height of every tower without a gap', () => {
    // A gap would drop a pane row through the floor of the lookup and hang its
    // windows off the side of the building, which is the bug this replaced.
    for (const archetype of towerArchetypes) {
      const spans = [...archetype.blocks].sort((a, b) => a.y0 - b.y0);
      expect(spans[0].y0).toBe(0);
      expect(Math.max(...spans.map((block) => block.y1))).toBe(1);
      let reach = 0;
      for (const block of spans) {
        expect(block.y0).toBeLessThanOrEqual(reach + 1e-9);
        expect(block.y1).toBeGreaterThan(block.y0);
        reach = Math.max(reach, block.y1);
      }
    }
  });

  it('keeps every mass inside the footprint it is scaled by, allowing for a crown', () => {
    for (const archetype of towerArchetypes) {
      for (const block of archetype.blocks) {
        expect(block.width).toBeGreaterThan(0);
        expect(block.depth).toBeGreaterThan(0);
        // An overhang is deliberate; anything much past the footprint is a typo.
        expect(Math.abs(block.offsetX ?? 0) + block.width / 2).toBeLessThanOrEqual(0.75);
        expect(Math.abs(block.offsetZ ?? 0) + block.depth / 2).toBeLessThanOrEqual(0.75);
      }
    }
  });

  it('actually varies the silhouette rather than only the scale', () => {
    // At least one archetype has to narrow on the way up, or the six are six boxes.
    const tapers = towerArchetypes.filter((archetype) => {
      const base = facadeAt(archetype.blocks, 0.05);
      const top = facadeAt(archetype.blocks, 0.9);
      return top.width < base.width * 0.9;
    });
    expect(tapers.length).toBeGreaterThanOrEqual(3);
  });
});

describe('reading the facade at a height', () => {
  const blocks = towerArchetypes.find((archetype) => archetype.id === 'setback')!.blocks;

  it('returns the mass the height falls inside', () => {
    expect(facadeAt(blocks, 0.1).width).toBe(1);
    expect(facadeAt(blocks, 0.6).width).toBeCloseTo(0.76, 5);
    expect(facadeAt(blocks, 0.85).width).toBeCloseTo(0.5, 5);
  });

  it('clamps rather than falling through at either end', () => {
    expect(facadeAt(blocks, -3)).toBe(facadeAt(blocks, 0));
    expect(facadeAt(blocks, 1)).toBeDefined();
    expect(facadeAt(blocks, 12)).toBeDefined();
  });
});

describe('facade lighting patterns', () => {
  it('never asks for more panes than the face was budgeted', () => {
    // The pane mesh is sized from the same budget, so an overrun would silently drop
    // the last towers' windows entirely.
    for (const pattern of facadePatterns) {
      for (const budget of [4, 12, 34, 58]) {
        for (const height of [12, 40, 90, 164]) {
          const layout = paneLayout(pattern, budget, 9, height);
          expect(layout.columns).toBeGreaterThanOrEqual(1);
          expect(layout.rows).toBeGreaterThanOrEqual(1);
          expect(layout.columns * layout.rows).toBeLessThanOrEqual(budget);
        }
      }
    }
  });

  it('lays the four patterns out differently enough to tell apart', () => {
    const shapes = facadePatterns.map((pattern) => {
      const layout = paneLayout(pattern, 40, 12, 80);
      return `${layout.columns > layout.rows}:${layout.fillWidth > layout.fillHeight}:${Math.round(layout.litChance * 10)}`;
    });
    expect(new Set(shapes).size).toBe(facadePatterns.length);
  });

  it('runs a ribbon as one wide pane per storey and a stack as narrow columns', () => {
    const ribbon = paneLayout('ribbon', 40, 12, 80);
    expect(ribbon.columns).toBe(1);
    expect(ribbon.fillWidth).toBeGreaterThan(ribbon.fillHeight);

    const stack = paneLayout('stack', 40, 12, 80);
    expect(stack.columns).toBeGreaterThan(1);
    expect(stack.fillHeight).toBeGreaterThan(stack.fillWidth);
  });

  it('leaves most of a sparse facade dark', () => {
    expect(paneLayout('sparse', 40, 12, 80).litChance).toBeLessThan(0.5);
    expect(paneLayout('grid', 40, 12, 80).litChance).toBeGreaterThan(0.5);
  });
});

describe('building tones', () => {
  it('separates the towers from the sky without breaking the value hierarchy', () => {
    const luminance = (hex: string): number => {
      const value = parseInt(hex.slice(1), 16);
      return (((value >> 16) & 255) * 0.2126 + ((value >> 8) & 255) * 0.7152 + (value & 255) * 0.0722) / 255;
    };
    expect(new Set(towerTones).size).toBe(towerTones.length);
    for (const tone of towerTones) {
      // Brighter than the single `#0a0f16` every tower used to be, so the mass reads
      // behind its own windows; still far darker than the emissive trim, which is what
      // AUDIT.md section 11 put the brightness in.
      expect(luminance(tone)).toBeGreaterThan(luminance('#0a0f16'));
      expect(luminance(tone)).toBeLessThan(0.16);
    }
  });
});
