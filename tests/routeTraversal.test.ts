import { describe, expect, it } from 'vitest';
import { Action, type CollisionPrimitiveV2, type InputFrame } from '../src/contracts';
import { playerHealth } from '../src/content/config';
import { cookLevel, defaultLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

function primitive(id: string): CollisionPrimitiveV2 {
  const found = defaultLevel.collision.find((entry) => entry.id === id);
  if (!found) throw new Error(`No primitive "${id}" on the route.`);
  return found;
}

/** Top of a flat deck, and the range of Z it covers. */
function deck(id: string): { top: number; nearZ: number; farZ: number } {
  const { transform } = primitive(id);
  return {
    top: transform.position[1] + transform.scale[1] / 2,
    nearZ: transform.position[2] + transform.scale[2] / 2,
    farZ: transform.position[2] - transform.scale[2] / 2,
  };
}

/**
 * The two ends of a ramp's walkable face, in world space.
 *
 * This is the arithmetic the level author had to do in their head, and got the sign of
 * wrong twice. A ramp is a cuboid rotated about X, so a point on the middle of its top
 * face is `(0, thickness / 2, t)` locally, and rotating that by the authored angle
 * gives where it actually ends up.
 */
function rampEnds(id: string): { near: { z: number; y: number }; far: { z: number; y: number } } {
  const { transform } = primitive(id);
  const [, height, length] = transform.scale;
  const angle = transform.rotation[0];
  const at = (t: number) => ({
    y: transform.position[1] + (height / 2) * Math.cos(angle) - t * Math.sin(angle),
    z: transform.position[2] + (height / 2) * Math.sin(angle) + t * Math.cos(angle),
  });
  const a = at(length / 2);
  const b = at(-length / 2);
  return a.z > b.z ? { near: a, far: b } : { near: b, far: a };
}

describe('the route joins up', () => {
  it('lands the first rise flush on the start floor and the bridge', () => {
    // The invariant that was missing. `rise-a` sloped the wrong way, so its face was
    // 2.9 m above the start floor at the near end and 0.4 m at the far end, and an
    // eight-metre hole sat between the two decks it was supposed to join.
    const start = deck('start-floor');
    const bridge = deck('bridge-a');
    const rise = rampEnds('rise-a');
    expect(rise.near.z).toBeCloseTo(start.farZ, 3);
    expect(rise.near.y).toBeCloseTo(start.top, 3);
    expect(rise.far.z).toBeCloseTo(bridge.nearZ, 3);
    expect(rise.far.y).toBeCloseTo(bridge.top, 3);
  });

  it('lands the second rise flush on the gallery and the sky route', () => {
    const gallery = deck('arena-two');
    const sky = deck('sky-route');
    const rise = rampEnds('rise-three');
    expect(rise.near.z).toBeCloseTo(gallery.farZ, 3);
    expect(rise.near.y).toBeCloseTo(gallery.top, 3);
    expect(rise.far.z).toBeCloseTo(sky.nearZ, 3);
    expect(rise.far.y).toBeCloseTo(sky.top, 3);
  });

  it('keeps both rises inside the slope the character controller will climb', () => {
    // `setMaxSlopeClimbAngle(Math.PI * 0.28)`, which is 50.4 degrees. A ramp steeper
    // than that is a wall with extra steps.
    for (const id of ['rise-a', 'rise-three']) {
      expect(Math.abs(primitive(id).transform.rotation[0])).toBeLessThan(Math.PI * 0.28);
    }
  });
});

describe('the route can be walked', () => {
  /** Holds one input for up to `ticks` and reports where the player got to. */
  async function walk(held: number, ticks: number) {
    const simulation = new FlowSimulation();
    await simulation.loadLevel(cookLevel(defaultLevel));
    for (let tick = 1; tick <= 6; tick += 1) simulation.step(frame(tick), TICK);
    let lowest = Number.POSITIVE_INFINITY;
    let furthest = 0;
    let died = 0;
    let output = simulation.step(frame(7), TICK);
    for (let tick = 8; tick <= ticks; tick += 1) {
      output = simulation.step(frame(tick, { held }), TICK);
      const [, y, z] = output.snapshot.entities[0].position;
      lowest = Math.min(lowest, y);
      furthest = Math.min(furthest, z);
      if (output.snapshot.player.awaitingRespawn) {
        died = tick;
        break;
      }
    }
    simulation.dispose();
    return { lowest, furthest, died, output };
  }

  it('walks from the spawn into the first arena without falling off it', async () => {
    // The regression, stated the way a player would: hold forward and you end up in
    // the fight rather than in the void. Before the ramp was fixed this died on tick
    // 263 at z = -20, having dropped off the end of the start floor.
    const { lowest, furthest, died } = await walk(Action.Forward, 500);
    expect(died).toBe(0);
    // The start floor is at zero and the arena deck at two, so nothing on the way
    // should ever put the player below the floor they started on.
    expect(lowest).toBeGreaterThan(0);
    // Past the atrium's near edge at z = -33.
    expect(furthest).toBeLessThan(-40);
  });

  it('sprints the same line without launching off the rise', async () => {
    const { died, furthest } = await walk(Action.Forward | Action.Sprint, 300);
    expect(died).toBe(0);
    expect(furthest).toBeLessThan(-40);
  });

  it('puts the player in reach of the atrium, and the atrium in reach of them', async () => {
    // Walking in is enough to start the fight: hostiles activate, they engage, and the
    // brawler closes to inside the blade. This is the case that makes combat reachable
    // at all -- for two commits it was not, because the route was not walkable.
    const { output } = await walk(Action.Forward, 500);
    // The first wave of the Atrium, and only the first: a wave that has not been
    // brought on contributes nothing to the snapshot, which is the whole reason the
    // route can hold twenty-eight hostiles.
    const hostiles = output.snapshot.entities.filter((entity) => entity.kind === 'bot');
    expect(hostiles.length).toBe(3);
    expect(output.snapshot.wave).toEqual({ current: 1, total: 2 });
    expect(output.snapshot.player.health).toBeLessThan(playerHealth);
  });
});
