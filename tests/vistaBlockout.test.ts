import { describe, expect, it } from 'vitest';
import type { CollisionPrimitiveV2 } from '../src/contracts';
import { validateLevel } from '../src/content/schema';
import { vistaBlockout, vistaBlockoutHints, vistaCone, vistaCones } from '../src/content/vistaBlockout';

function primitive(id: string): CollisionPrimitiveV2 {
  const found = vistaBlockout.collision.find((entry) => entry.id === id);
  if (!found) throw new Error(`No primitive "${id}" in the blockout.`);
  return found;
}

/** Top of a flat deck, and the range of X it covers. */
function deck(id: string): { top: number; nearX: number; farX: number } {
  const { transform } = primitive(id);
  return {
    top: transform.position[1] + transform.scale[1] / 2,
    nearX: transform.position[0] + transform.scale[0] / 2,
    farX: transform.position[0] - transform.scale[0] / 2,
  };
}

/**
 * The two ends of an X-axis ramp's walkable face, in world space.
 *
 * The same arithmetic `rampAlongX` inverts, run forward. A cuboid rotated about Z puts
 * the middle of its top face at `(t·cos - (h/2)·sin, t·sin + (h/2)·cos)` for `t` along
 * its own length, so this is the check that the sign of the angle is the one that
 * actually lands on both decks -- the mistake the Z-axis ramps made twice.
 */
function rampEnds(id: string): { near: { x: number; y: number }; far: { x: number; y: number } } {
  const { transform } = primitive(id);
  const [length, height] = transform.scale;
  const angle = transform.rotation[2];
  const at = (t: number) => ({
    x: transform.position[0] + t * Math.cos(angle) - (height / 2) * Math.sin(angle),
    y: transform.position[1] + t * Math.sin(angle) + (height / 2) * Math.cos(angle),
  });
  const a = at(length / 2);
  const b = at(-length / 2);
  return a.x > b.x ? { near: a, far: b } : { near: b, far: a };
}

describe('the blockout is a level', () => {
  it('validates', () => {
    const { errors } = validateLevel(vistaBlockout);
    expect(errors).toEqual([]);
  });

  it('hands every cone to the look nudge, so the two cannot drift', () => {
    expect(vistaBlockout.vistaHints).toBe(vistaBlockoutHints);
    expect(vistaBlockoutHints).toHaveLength(vistaCones.length);
    for (const cone of vistaCones) {
      const hint = vistaBlockoutHints.find((entry) => entry.id === `hint-${cone.id}`)!;
      expect(hint).toBeDefined();
      expect(hint.at).toEqual(cone.origin);
      expect(hint.pitch).toBe(cone.pitch);
      expect(hint.yaw).toBe(cone.yaw);
      expect(hint.radius).toBeGreaterThan(0);
    }
  });

  it('spawns the player in the slot facing the dead end', () => {
    const spawns = vistaBlockout.spawns.filter((spawn) => spawn.kind === 'player');
    expect(spawns).toHaveLength(1);
    const slot = primitive('slot-floor');
    const [x, , z] = spawns[0].position;
    expect(Math.abs(x)).toBeLessThanOrEqual(slot.transform.scale[0] / 2);
    expect(z).toBeLessThan(slot.transform.position[2] + slot.transform.scale[2] / 2);
    // rotationY 0 is down -Z, which is the length of the slot.
    expect(spawns[0].rotationY).toBe(0);
  });
});

describe('the blockout route joins up', () => {
  it('lands the rise flush on the street and the ledge', () => {
    const street = deck('street-floor');
    const ledge = deck('ledge-floor');
    const rise = rampEnds('street-rise');
    expect(rise.near.x).toBeCloseTo(street.farX, 3);
    expect(rise.near.y).toBeCloseTo(street.top, 3);
    expect(rise.far.x).toBeCloseTo(ledge.nearX, 3);
    expect(rise.far.y).toBeCloseTo(ledge.top, 3);
  });

  it('runs the slot into the street with no seam and no way out to the right', () => {
    const slot = primitive('slot-floor');
    const street = primitive('street-floor');
    // The slot's far end is inside the street deck, so there is nothing to fall through.
    const slotFarZ = slot.transform.position[2] - slot.transform.scale[2] / 2;
    const streetNearZ = street.transform.position[2] + street.transform.scale[2] / 2;
    expect(streetNearZ).toBeGreaterThan(slotFarZ);
    expect(deck('street-floor').top).toBeCloseTo(deck('slot-floor').top, 3);
    // The street reaches past the slot's mouth on both sides, and is closed on the side
    // the route does not go.
    const end = primitive('street-end-wall');
    expect(deck('street-floor').nearX).toBeGreaterThan(slot.transform.scale[0] / 2);
    expect(end.transform.position[0]).toBeGreaterThan(slot.transform.scale[0] / 2);
    expect(end.transform.scale[1]).toBeGreaterThan(20);
  });

  it('breaks the cliff where the slot enters, so the mouth is not walled shut', () => {
    const cliff = primitive('street-cliff-left');
    const slotRightEdge = -primitive('slot-floor').transform.scale[0] / 2;
    // The cliff's near end starts at or past the slot's far edge.
    expect(cliff.transform.position[0] + cliff.transform.scale[0] / 2).toBeLessThanOrEqual(slotRightEdge + 0.001);
  });

  it('leaves nothing tall on the flank the reveal opens', () => {
    // The bug this level was rebuilt around. Anything above head height between the
    // reveal point and the parapet closes the composition, whatever else is right.
    const reveal = vistaCone('reveal')!;
    const offenders = vistaBlockout.collision.filter((entry) => {
      if (!entry.collision) return false;
      const [x, y, z] = entry.transform.position;
      const [sx, sy, sz] = entry.transform.scale;
      const tall = y + sy / 2 > reveal.origin[1] + 2.5;
      // Between the reveal and the parapet in Z, and down the street in X.
      const onTheOpenFlank = z - sz / 2 < reveal.origin[2] - 1 && z + sz / 2 < reveal.origin[2] + 1;
      const downStreet = x - sx / 2 < reveal.origin[0] && x + sx / 2 > reveal.origin[0] - 70;
      return tall && onTheOpenFlank && downStreet;
    });
    expect(offenders.map((entry) => entry.id)).toEqual([]);
  });

  it('leaves exactly one gap, and leaves a wall-run panel down the side of it', () => {
    const ledge = deck('ledge-floor');
    const balcony = deck('balcony-floor');
    const gap = ledge.farX - balcony.nearX;
    expect(gap).toBeCloseTo(6, 3);
    // Crossing it is movement tech rather than walking, so the panel has to span it.
    const panel = primitive('gap-wall-right');
    expect(panel.traversal.wallRun).toBe(true);
    const panelNear = panel.transform.position[0] + panel.transform.scale[0] / 2;
    const panelFar = panel.transform.position[0] - panel.transform.scale[0] / 2;
    expect(panelNear).toBeGreaterThanOrEqual(ledge.farX);
    expect(panelFar).toBeLessThanOrEqual(balcony.nearX);
  });

  it('runs the balcony into the overlook and the overlook into the finish', () => {
    expect(deck('balcony-floor').farX).toBeCloseTo(deck('overlook-floor').nearX, 3);
    expect(deck('overlook-floor').top).toBeCloseTo(deck('balcony-floor').top, 3);
    const finish = primitive('finish');
    const overlook = deck('overlook-floor');
    expect(finish.transform.position[0] + finish.transform.scale[0] / 2).toBeGreaterThan(overlook.farX);
    expect(vistaBlockout.exit[0]).toBeCloseTo(finish.transform.position[0], 3);
  });
});

describe('the composition costs nothing to walk on', () => {
  const masses = vistaBlockout.collision.filter((entry) => !entry.collision);

  it('carries four masses and none of them is a surface', () => {
    expect(masses.map((entry) => entry.id)).toEqual([
      'hero-tower', 'far-slab', 'mid-block', 'sky-bridge',
    ]);
    for (const entry of masses) {
      expect(entry.nav.includeInBake).toBe(false);
      expect(entry.nav.walkable).toBe(false);
      expect(entry.traversal.wallRun).toBe(false);
      expect(entry.traversal.grapple).toBe(false);
    }
  });

  it('gives them no catalogued art, because a tower is not a scaled platform', () => {
    const ids = new Set(vistaBlockout.visuals.map((visual) => visual.collisionAlignmentId));
    for (const entry of masses) expect(ids.has(entry.id)).toBe(false);
  });

  it('keeps the tower clear of the street it stands beside', () => {
    const tower = primitive('hero-tower');
    const parapet = primitive('street-parapet-right');
    const towerNearZ = tower.transform.position[2] + tower.transform.scale[2] / 2;
    const streetEdgeZ = parapet.transform.position[2];
    expect(towerNearZ).toBeLessThan(streetEdgeZ);
  });
});

/**
 * The composition, as numbers.
 *
 * These are the assertions that make this a level built *for* a camera rather than a
 * plan view. The reveal happens at the turn, so the cone is anchored there: eye height
 * on the turn pad, heading -X, and what has to be true is that the subject is far
 * enough away to read as enormous, near enough to fill the frame, and inside the
 * horizontal span a first-person camera is actually pointing at.
 */
describe('the reveal is composed for the angle the player will be at', () => {
  // Read off the level's own authored cone rather than restated here, so moving the
  // vantage point moves what the composition is judged from.
  const reveal = vistaCone('reveal')!;
  const eye = { x: reveal.origin[0], y: reveal.origin[1] + 0.5, z: reveal.origin[2] };

  it('names a cone for every composition it claims to have', () => {
    expect(vistaCones.map((cone) => cone.id)).toEqual(['slot', 'reveal', 'street', 'overlook']);
    // Every cone has to stand on something, or the shot is of the player falling.
    for (const cone of vistaCones) {
      const under = vistaBlockout.collision.filter((entry) => {
        if (!entry.collision || entry.kind !== 'box') return false;
        const [x, y, z] = entry.transform.position;
        const [sx, sy, sz] = entry.transform.scale;
        return Math.abs(cone.origin[0] - x) <= sx / 2
          && Math.abs(cone.origin[2] - z) <= sz / 2
          && y + sy / 2 <= cone.origin[1] + 0.2;
      });
      expect(under.length, `nothing under cone ${cone.id}`).toBeGreaterThan(0);
    }
  });

  function fromEye(id: string): { distance: number; bearing: number; topAngle: number } {
    const { transform } = primitive(id);
    const dx = eye.x - transform.position[0];
    const dz = transform.position[2] - eye.z;
    const distance = Math.hypot(dx, dz);
    return {
      distance,
      // Signed degrees off the -X heading. Positive is to the player's right, which is -Z.
      bearing: (Math.atan2(-dz, dx) * 180) / Math.PI,
      topAngle: (Math.atan2(transform.position[1] + transform.scale[1] / 2 - eye.y, distance) * 180) / Math.PI,
    };
  }

  it('puts the tower far enough out to read as enormous and near enough to dominate', () => {
    const tower = fromEye('hero-tower');
    expect(tower.distance).toBeGreaterThan(150);
    expect(tower.distance).toBeLessThan(190);
    // Right of the heading, and well inside the 61-degree horizontal half-angle a
    // 92-degree vertical FOV gives at 16:9.
    expect(tower.bearing).toBeGreaterThan(5);
    expect(tower.bearing).toBeLessThan(26);
  });

  it('gives the tower enough angular width to be the subject at this FOV', () => {
    // The trap the wide camera sets. A 122-degree horizontal frame shrinks everything,
    // so a mass sized off the reference photograph reads as a distant slab. A fifth of
    // the frame's width is the floor for something that is meant to be the subject.
    const tower = primitive('hero-tower');
    const { distance } = fromEye('hero-tower');
    const angularWidth = (2 * Math.atan(tower.transform.scale[0] / 2 / distance) * 180) / Math.PI;
    const horizontalFov = (2 * Math.atan(Math.tan((92 / 2) * Math.PI / 180) * (16 / 9)) * 180) / Math.PI;
    expect(angularWidth / horizontalFov).toBeGreaterThan(0.28);
  });

  it('runs the tower out of the top of the frame rather than into it', () => {
    // A mass whose crown is in frame is a model of a building. Above sixty degrees the
    // top edge is off-screen at every FOV this game uses, so the eye never finds the end.
    expect(fromEye('hero-tower').topAngle).toBeGreaterThan(60);
  });

  it('leaves sky on both sides of the subject', () => {
    // What separates a subject from a wall. The first two passes had the tower's far
    // side running off the right edge of frame, which turned it into the frame's right
    // wall with the cliff as its left -- a corridor with a very tall corridor wall.
    const tower = primitive('hero-tower');
    const halfFrame = (Math.atan(Math.tan((92 / 2) * Math.PI / 180) * (16 / 9)) * 180) / Math.PI;
    const corner = (z: number) => {
      const dx = eye.x - (tower.transform.position[0] + tower.transform.scale[0] / 2);
      return (Math.atan2(eye.z - z, dx) * 180) / Math.PI;
    };
    const near = corner(tower.transform.position[2] + tower.transform.scale[2] / 2);
    const far = corner(tower.transform.position[2] - tower.transform.scale[2] / 2);
    expect(near).toBeGreaterThan(2);
    expect(far).toBeLessThan(halfFrame - 4);
  });

  it('keeps the floor out of half the frame', () => {
    // The reason pitch is authored at all. With a 92-degree vertical field and an eye
    // height of a metre and a half, a level camera spends the whole bottom half of every
    // frame on the ground plane; the reference has almost none in it.
    const horizonFraction = 0.5 + Math.tan(reveal.pitch) / Math.tan((92 / 2) * Math.PI / 180) * 0.5;
    expect(horizonFraction).toBeGreaterThan(0.66);
  });

  it('keeps the parapet below the eye standing behind it', () => {
    // Found by projecting rather than by reading the numbers: at 2.2 m the parapet's top
    // was 0.7 m *above* the eye of a player standing on this deck, so a shot over it was
    // a shot at the inside of a wall.
    const cone = vistaCone('overlook')!;
    const parapet = primitive('overlook-parapet-right');
    expect(parapet.transform.position[1] + parapet.transform.scale[1] / 2).toBeLessThan(cone.origin[1] + 0.4);
  });

  it('ends the route close enough to the tower to look up it', () => {
    // The fourth shot is the payoff for the route running toward the subject the whole
    // way. It only works if the tower is genuinely overhead by the end.
    const cone = vistaCone('overlook')!;
    const tower = primitive('hero-tower');
    const nearZ = tower.transform.position[2] + tower.transform.scale[2] / 2;
    expect(cone.origin[2] - nearZ).toBeLessThan(25);
    const crown = tower.transform.position[1] + tower.transform.scale[1] / 2;
    const elevation = (Math.atan2(crown - cone.origin[1], cone.origin[2] - nearZ) * 180) / Math.PI;
    // Steeply overhead, and pitched far enough up that the ground plane is a sliver at
    // the bottom edge rather than a third of the image.
    expect(elevation).toBeGreaterThan(80);
    const horizonFraction = 0.5 + Math.tan(cone.pitch) / Math.tan((92 / 2) * Math.PI / 180) * 0.5;
    expect(horizonFraction).toBeGreaterThan(0.9);
  });

  it('opens one flank and closes the other, which is what stops it being a trench', () => {
    const cliff = primitive('street-cliff-left');
    const parapet = primitive('street-parapet-right');
    expect(cliff.transform.scale[1]).toBeGreaterThan(30);
    // Waist high: a player standing on the street looks over it at the city.
    expect(parapet.transform.scale[1]).toBeLessThan(eye.y * 2.5);
  });
});
