import { describe, expect, it } from 'vitest';
import type { CollisionPrimitiveV2 } from '../src/contracts';
import { defaultLevel } from '../src/content/defaultLevel';
import { validateLevel } from '../src/content/schema';
import { lookNudge as profile } from '../src/content/config';

const masses = defaultLevel.collision.filter((entry) => !entry.collision);
const route = defaultLevel.collision.filter((entry) => entry.collision);

/** World-space AABB, ignoring rotation -- deliberately generous for an overlap check. */
function bounds(entry: CollisionPrimitiveV2) {
  const [x, y, z] = entry.transform.position;
  const [sx, sy, sz] = entry.transform.scale;
  const spread = Math.max(sx, sz) / 2;
  const rotated = entry.transform.rotation.some((angle) => angle !== 0);
  return {
    minX: x - (rotated ? spread : sx / 2), maxX: x + (rotated ? spread : sx / 2),
    minY: y - sy / 2, maxY: y + sy / 2,
    minZ: z - (rotated ? spread : sz / 2), maxZ: z + (rotated ? spread : sz / 2),
  };
}

function overlaps(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>): boolean {
  return a.minX < b.maxX && a.maxX > b.minX
    && a.minY < b.maxY && a.maxY > b.minY
    && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

describe('the composition layer costs the route nothing', () => {
  it('still validates', () => {
    expect(validateLevel(defaultLevel).errors).toEqual([]);
  });

  it('adds six masses and no surfaces', () => {
    expect(masses.map((entry) => entry.id)).toEqual([
      'hero-spire', 'void-wall',
      'roof-below-a', 'roof-below-b', 'roof-counterweight', 'sky-span',
    ]);
    for (const entry of masses) {
      expect(entry.nav.includeInBake).toBe(false);
      expect(entry.nav.walkable).toBe(false);
      expect(entry.traversal.wallRun).toBe(false);
      expect(entry.traversal.grapple).toBe(false);
    }
  });

  it('leaves everything the route is walked on exactly where it was', () => {
    // This started as a primitive count and that was the wrong guard: it failed the
    // moment a flank was deliberately opened, which is a change the route is *supposed*
    // to be able to make. What actually has to hold for `routeTraversal` and `waves` to
    // stay evidence about the shipped route is that nothing the player stands on, and
    // nothing that decides where a fight happens, has moved.
    const surfaces = route.filter((entry) => entry.transform.scale[1] <= 2 && entry.surface === 'default');
    expect(surfaces.map((entry) => entry.id)).toEqual([
      'start-floor', 'rise-a', 'bridge-a', 'arena-one', 'step-one', 'run-two',
      'run-two-gap-platform', 'arena-two', 'rise-three', 'sky-route', 'final-arena', 'finish',
    ]);
    expect(route.find((entry) => entry.id === 'start-floor')!.transform.position).toEqual([0, -0.5, 0]);
    expect(route.find((entry) => entry.id === 'final-arena')!.transform.position).toEqual([0, 10, -148]);
    expect(defaultLevel.spawns).toHaveLength(29);
    expect(defaultLevel.encounters.map((encounter) => encounter.id)).toEqual(['arena-1', 'arena-2', 'arena-3']);
    expect(defaultLevel.offMeshLinks).toHaveLength(2);
    expect(defaultLevel.exit).toEqual([0, 12, -164]);
  });

  it('never stands a mass in a space the player occupies', () => {
    // A 520 m spire is cheap and invisible to the simulation, which is exactly why it
    // has to be checked: nothing would stop one being authored through the middle of an
    // arena, and nothing in the game would complain.
    const collisions: string[] = [];
    for (const entry of masses) {
      const box = bounds(entry);
      for (const surface of route) {
        if (overlaps(box, bounds(surface))) collisions.push(`${entry.id} / ${surface.id}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('gets no catalogued art, and the route keeps all of its own', () => {
    const aligned = new Set(defaultLevel.visuals.map((visual) => visual.collisionAlignmentId));
    for (const entry of masses) expect(aligned.has(entry.id)).toBe(false);
    // Every route primitive except the three gates still wears its art.
    const gates = route.filter((entry) => entry.gateForEncounterId).length;
    expect(route.filter((entry) => aligned.has(entry.id))).toHaveLength(route.length - gates);
  });
});

describe('the route hints the view at its approaches', () => {
  it('places one hint per movement, ahead of each room rather than inside it', () => {
    expect(defaultLevel.vistaHints.map((hint) => hint.id)).toEqual([
      'hint-canyon', 'hint-bridge', 'hint-gallery-approach', 'hint-roofline',
    ]);
    // Descending down the route, so they fire in the order the player meets them.
    const zs = defaultLevel.vistaHints.map((hint) => hint.at[2]);
    expect([...zs].sort((a, b) => b - a)).toEqual(zs);
  });

  it('keeps every hint out of the arenas the nudge would be disarmed in', () => {
    // Not a style rule: a hostile inside `disarmRange` disarms the nudge outright, so a
    // hint standing among spawns is a hint that never fires.
    const hostiles = defaultLevel.spawns.filter((spawn) => spawn.kind !== 'player');
    for (const hint of defaultLevel.vistaHints) {
      const nearest = Math.min(...hostiles.map((spawn) => Math.hypot(
        spawn.position[0] - hint.at[0],
        spawn.position[1] - hint.at[1],
        spawn.position[2] - hint.at[2],
      )));
      expect(nearest, `${hint.id} sits ${nearest.toFixed(1)} m from a spawn`).toBeGreaterThan(hint.radius);
    }
  });

  it('asks for pitches a nudge can actually deliver', () => {
    for (const hint of defaultLevel.vistaHints) {
      expect(hint.pitch).toBeGreaterThan(0);
      expect(hint.pitch).toBeLessThanOrEqual(profile.maxPitchOffset);
    }
  });
});


/**
 * The arenas, after opening one flank of each.
 *
 * Both fights used to be walled to eight metres on both sides at the same height, which
 * is the geometry that makes a room read as a trench whatever the renderer does with it.
 * The trade is a parapet out and a wall-run fin in, and both halves of it have to hold or
 * the change is either cosmetic or a movement regression.
 */
describe('each arena has one closed flank and one open one', () => {
  const arenas = [
    { id: 'arena-one', deck: 2, tall: 'arena-one-left', open: 'arena-one-right', fin: 'arena-one-fin' },
    { id: 'arena-two', deck: 6, tall: 'arena-two-left', open: 'arena-two-right', fin: 'arena-two-fin' },
  ];

  it.each(arenas)('opens $open and keeps $tall closed', ({ deck, tall, open }) => {
    const closed = route.find((entry) => entry.id === tall)!;
    const parapet = route.find((entry) => entry.id === open)!;
    expect(closed.transform.scale[1]).toBeGreaterThan(6);
    // Above the deck by enough to stop a walk, below the eye by enough to see over.
    const top = parapet.transform.position[1] + parapet.transform.scale[1] / 2;
    expect(top - deck).toBeGreaterThan(0.5);
    expect(top).toBeLessThan(deck + 1.48);
    // And it is not a surface, so nothing about it reads as traversal.
    expect(parapet.surface).toBe('no-traverse');
    expect(parapet.traversal.wallRun).toBe(false);
    expect(parapet.traversal.mantle).toBe(false);
  });

  it.each(arenas)('keeps a wall-run surface inside $id', ({ id, fin }) => {
    const arena = route.find((entry) => entry.id === id)!;
    const panel = route.find((entry) => entry.id === fin)!;
    expect(panel.traversal.wallRun).toBe(true);
    // Inside the room, not on its edge -- that is what makes it usable mid-chain.
    const halfWidth = arena.transform.scale[0] / 2;
    expect(Math.abs(panel.transform.position[0])).toBeLessThan(halfWidth - 2);
    // And tall enough off the deck to be worth running along.
    expect(panel.transform.scale[1]).toBeGreaterThanOrEqual(6);
  });

  it('never spawns a hostile inside something solid', () => {
    // Two interior walls just went into rooms that hold twenty-eight hostiles between
    // them. A bot inside a collider is a bot that never joins the fight, and nothing in
    // the game would report it.
    const solids = route.filter((entry) => entry.transform.scale[1] > 2);
    const trapped: string[] = [];
    for (const spawn of defaultLevel.spawns) {
      for (const solid of solids) {
        const [x, y, z] = solid.transform.position;
        const [sx, sy, sz] = solid.transform.scale;
        // Half a metre of clearance, which is a bot's capsule radius plus a little.
        const inside = Math.abs(spawn.position[0] - x) < sx / 2 + 0.5
          && Math.abs(spawn.position[1] - y) < sy / 2 + 0.5
          && Math.abs(spawn.position[2] - z) < sz / 2 + 0.5;
        if (inside) trapped.push(`${spawn.id} in ${solid.id}`);
      }
    }
    expect(trapped).toEqual([]);
  });
});
