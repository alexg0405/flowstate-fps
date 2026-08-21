import { describe, expect, it } from 'vitest';
import { POSE_HZ, stepAdvance, steppedTime } from '../src/render/presentation/animationStepping';
import { directCamera, FOV_DIRECTION, isTouchdown } from '../src/render/presentation/cameraDirection';
import { FACE_BLEND, faceOf, FACE_TINT, paintByFacing } from '../src/render/presentation/facePaint';
import { angularRing, fracture, shard, starBurst } from '../src/render/presentation/graphicShapes';

const luma = (colour: readonly number[]) => colour[0] * 0.2126 + colour[1] * 0.7152 + colour[2] * 0.0722;

describe('the shapes combat is drawn with', () => {
  it('builds a star as whole triangles, with the spokes it was asked for', () => {
    const burst = starBurst(7, 0.3, 4);
    // A fan of one triangle per half-spoke, three vertices each, three floats each.
    expect(burst.positions).toHaveLength(7 * 2 * 9);
    expect(burst.positions.length % 9).toBe(0);
    expect(burst.radius).toBeGreaterThan(0.5);
  });

  it('never draws the same star twice', () => {
    // A held trigger stamping one identical shape is the most artificial thing a
    // pooled effect can do, and it is the same rule the mix's per-event variation
    // follows: arbitrary is fine, identical is not.
    const first = starBurst(7, 0.3, 1);
    const second = starBurst(7, 0.3, 2);
    expect(Array.from(first.positions)).not.toEqual(Array.from(second.positions));
    // And deterministic, so a replay draws the frame it drew the first time.
    expect(Array.from(starBurst(7, 0.3, 1).positions)).toEqual(Array.from(first.positions));
  });

  it('makes a fracture irregular, which is the whole of what makes it read as broken', () => {
    const broken = fracture(6, 3);
    const radii: number[] = [];
    for (let index = 0; index < broken.positions.length; index += 9) {
      radii.push(Math.hypot(broken.positions[index + 3], broken.positions[index + 4]));
    }
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.15);
  });

  it('keeps a shard flat, because it is a mark rather than a solid', () => {
    const sliver = shard(2);
    expect(sliver.positions).toHaveLength(9);
    for (let index = 2; index < sliver.positions.length; index += 3) expect(sliver.positions[index]).toBe(0);
  });

  it('gives the ring corners rather than segments', () => {
    // Twenty-eight segments is a circle, and a circle is the one shape this whole
    // vocabulary does not contain.
    const ring = angularRing(6, 0.8);
    expect(ring.positions).toHaveLength(6 * 18);
  });
});

describe('the camera as an authored system', () => {
  const still = { drive: 0, locomotion: 'grounded', landing: 0, reducedMotion: false } as const;

  it('does nothing at all under reduced motion', () => {
    expect(directCamera({ ...still, drive: 1, locomotion: 'grappling', reducedMotion: true }).offset).toBe(0);
  });

  it('opens with speed and opens further on a hook', () => {
    expect(directCamera(still).offset).toBe(0);
    const fast = directCamera({ ...still, drive: 1 }).offset;
    expect(fast).toBeCloseTo(FOV_DIRECTION.speed, 5);
    // A grapple is the one move where the player is travelling a line they chose and
    // watching it arrive, so it is the widest thing in the vocabulary.
    expect(directCamera({ ...still, drive: 1, locomotion: 'grappling' }).offset).toBeGreaterThan(fast);
    expect(directCamera({ ...still, drive: 1, locomotion: 'airborne' }).offset).toBeGreaterThan(fast);
  });

  it('compresses on landing, and recovers on its own damping', () => {
    const landing = directCamera({ ...still, landing: 1 });
    // The only negative term in the vocabulary.
    expect(landing.offset).toBeLessThan(0);
    // And it snaps rather than wallows, which is the half that makes it read as impact.
    expect(landing.damping).toBeGreaterThan(directCamera(still).damping);
  });

  it('clamps, so nothing can stack into a fisheye', () => {
    const extreme = directCamera({ drive: 1, locomotion: 'grappling', landing: 0, reducedMotion: false });
    expect(Math.abs(extreme.offset)).toBeLessThanOrEqual(FOV_DIRECTION.limit);
  });

  it('knows a landing from any other change of state', () => {
    expect(isTouchdown('airborne', 'grounded')).toBe(true);
    expect(isTouchdown('grappling', 'sliding')).toBe(true);
    expect(isTouchdown(null, 'grounded')).toBe(false);
    expect(isTouchdown('grounded', 'airborne')).toBe(false);
    expect(isTouchdown('grounded', 'grounded')).toBe(false);
  });
});

describe('animating on twos', () => {
  it('holds a pose until a whole step is owed', () => {
    const frame = 1 / 60;
    expect(stepAdvance(frame).advance).toBe(0);
    // Twelve poses a second against sixty frames: every fifth frame moves.
    let pending = 0;
    let moved = 0;
    for (let frames = 0; frames < 60; frames += 1) {
      const stepped = stepAdvance(pending + frame);
      pending = stepped.pending;
      if (stepped.advance > 0) moved += 1;
    }
    expect(moved).toBe(POSE_HZ);
  });

  it('carries the remainder, so stepped animation does not run slow', () => {
    // The correctness of the whole thing. Dropping the remainder would lose up to a
    // step per frame, which at 144 Hz is most of the animation.
    let pending = 0;
    let total = 0;
    for (let frames = 0; frames < 600; frames += 1) {
      const stepped = stepAdvance(pending + 1 / 144);
      pending = stepped.pending;
      total += stepped.advance;
    }
    expect(total).toBeGreaterThan(600 / 144 - 1 / POSE_HZ);
    // Never *ahead* of real time either, bar the last bit of floating point.
    expect(total).toBeLessThanOrEqual(600 / 144 + 1e-12);
  });

  it('passes everything through when stepping is off', () => {
    expect(stepAdvance(0.017, 0)).toEqual({ advance: 0.017, pending: 0 });
    expect(steppedTime(1.234, 0)).toBe(1.234);
  });

  it('quantises an absolute clock to the same grid', () => {
    expect(steppedTime(1.0)).toBeCloseTo(1, 6);
    expect(steppedTime(1.04)).toBeCloseTo(1, 6);
    expect(steppedTime(1.09)).toBeCloseTo(1 + 1 / POSE_HZ, 6);
  });
});

describe('painting a mass by which way it faces', () => {
  it('picks a face by dominant axis, with nothing in between', () => {
    expect(faceOf(0, 1, 0)).toBe('up');
    expect(faceOf(0, -1, 0)).toBe('down');
    expect(faceOf(1, 0, 0)).toBe('east');
    expect(faceOf(-1, 0, 0)).toBe('west');
    expect(faceOf(0, 0, 1)).toBe('north');
    expect(faceOf(0, 0, -1)).toBe('south');
    // A face leaning slightly is still that face: the hard boundary is the composition.
    expect(faceOf(0.9, 0.3, 0.2)).toBe('east');
  });

  it('makes the four vertical sides four different decisions', () => {
    // A box lit evenly reads as a box. This is the whole trick, so the sides have to
    // actually differ -- one pale, one dark, one warm, one in shadow.
    const sides = ['east', 'west', 'north', 'south'] as const;
    const values = sides.map((side) => luma(FACE_TINT[side]));
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.4);
    // And the magenta side is warm where the cyan side is cool, rather than both being
    // the same colour at two levels.
    expect(FACE_TINT.north[0]).toBeGreaterThan(FACE_TINT.north[2]);
    expect(FACE_TINT.east[2]).toBeGreaterThan(FACE_TINT.east[0]);
  });

  it('lets a downward face collapse into near-nothing', () => {
    expect(luma(FACE_TINT.down)).toBeLessThan(0.25);
    expect(luma(FACE_TINT.up)).toBeGreaterThan(luma(FACE_TINT.down) * 4);
  });

  it('is the dominant axis at mass hardness, and a blend at authored hardness', () => {
    // The same function serves a stack of boxes and an imported wall. A box wants the
    // boundary between two faces to be a decision; authored art has smoothed normals
    // around its bevels, and a hard rule there seams a surface it was never describing.
    const diagonal = new Float32Array([Math.SQRT1_2, 0, Math.SQRT1_2]);
    const hard = paintByFacing(diagonal, FACE_BLEND.mass);
    const soft = paintByFacing(diagonal, FACE_BLEND.authored);
    // Exactly halfway between east and north at either hardness, because the normal is.
    for (const painted of [hard, soft]) {
      expect(painted[0]).toBeCloseTo((FACE_TINT.east[0] + FACE_TINT.north[0]) / 2, 4);
    }
    // Off the diagonal is where they part: the hard rule has all but snapped to one face
    // while the soft one is still carrying a quarter of the other.
    const leaning = new Float32Array([0.8, 0, 0.6]);
    const snapped = paintByFacing(leaning, FACE_BLEND.mass);
    const eased = paintByFacing(leaning, FACE_BLEND.authored);
    const pull = (painted: Float32Array) => Math.abs(painted[0] - FACE_TINT.east[0]);
    expect(snapped[0]).toBeCloseTo(FACE_TINT.east[0], 2);
    expect(pull(eased)).toBeGreaterThan(pull(snapped) * 5);
  });

  it('leaves a normal that points nowhere unpainted rather than black', () => {
    // A degenerate normal has no face to belong to, and a mass with a hole in it is a
    // worse outcome than one panel that takes no tint.
    expect(Array.from(paintByFacing(new Float32Array([0, 0, 0])))).toEqual([1, 1, 1]);
  });

  it('paints one colour per vertex, flat across a face', () => {
    const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
    const colours = paintByFacing(normals);
    expect(colours).toHaveLength(normals.length);
    expect(Array.from(colours.slice(0, 3))).toEqual(FACE_TINT.up.map((value) => Math.fround(value)));
    expect(Array.from(colours.slice(0, 9))).toEqual(Array.from(colours.slice(0, 3)).concat(Array.from(colours.slice(0, 3)), Array.from(colours.slice(0, 3))));
    expect(Array.from(colours.slice(9, 12))).toEqual(FACE_TINT.east.map((value) => Math.fround(value)));
  });
});
