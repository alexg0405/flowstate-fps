import { describe, expect, it } from 'vitest';
import { Action, type InputFrame, type LegacyLevelDocumentV1 } from '../src/contracts';
import { movementProfile, playerCapsule, recoilAdsFactor, recoilHoldSeconds } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { defaultBuildFor, resolveWeaponStats } from '../src/content/weapons';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function frame(tick: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...overrides };
}

function flat(primitives: LegacyLevelDocumentV1['primitives'] = []): LegacyLevelDocumentV1 {
  return {
    schemaVersion: 1,
    id: 'range',
    name: 'Range',
    units: 'meters',
    primitives: [
      {
        id: 'floor', kind: 'box', color: '#fff', collision: true, surface: 'default',
        transform: { position: [0, -0.5, -20], rotation: [0, 0, 0], scale: [30, 1, 80] },
      },
      ...primitives,
    ],
    spawns: [{ id: 'player', kind: 'player', position: [0, 1, 0], rotationY: 0 }],
    encounters: [],
    offMeshLinks: [],
    exit: [0, 1, -200],
  };
}

async function range(chassis: Parameters<typeof defaultBuildFor>[0] = 'carbine'): Promise<FlowSimulation> {
  const build = defaultBuildFor(chassis, 'test', 'Test');
  const simulation = new FlowSimulation(undefined, [build, build]);
  await simulation.loadLevel(cookLevel(flat()));
  // Settle on the floor before anything is measured.
  for (let tick = 1; tick <= 20; tick += 1) simulation.step(frame(tick), TICK);
  return simulation;
}

describe('recoil moves the aim', () => {
  it('kicks the view up on every shot', async () => {
    const simulation = await range();
    const before = simulation.step(frame(21), TICK).snapshot.camera.pitch;
    const after = simulation.step(frame(22, { held: Action.Fire, pressed: Action.Fire }), TICK).snapshot.camera.pitch;
    // Positive pitch is up, and the viewmodel kick was previously the only thing that
    // moved at all -- the aim itself never did.
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeCloseTo(resolveWeaponStats(defaultBuildFor('carbine', 't', 'T')).recoilPitch, 5);
    simulation.dispose();
  });

  it('climbs across a burst', async () => {
    const simulation = await range();
    const start = simulation.step(frame(21), TICK).snapshot.camera.pitch;
    let output = simulation.step(frame(22, { held: Action.Fire, pressed: Action.Fire }), TICK);
    for (let tick = 23; tick <= 90; tick += 1) output = simulation.step(frame(tick, { held: Action.Fire }), TICK);
    // Recovery is suspended between shots, so the pattern accumulates instead of being
    // cancelled by a recovery rate fast enough to settle between bursts.
    expect(output.snapshot.camera.pitch - start).toBeGreaterThan(0.02);
    simulation.dispose();
  });

  it('hands the view back once firing stops', async () => {
    const simulation = await range();
    const start = simulation.step(frame(21), TICK).snapshot.camera.pitch;
    let output = simulation.step(frame(22, { held: Action.Fire, pressed: Action.Fire }), TICK);
    for (let tick = 23; tick <= 70; tick += 1) output = simulation.step(frame(tick, { held: Action.Fire }), TICK);
    const climbed = output.snapshot.camera.pitch;

    for (let tick = 71; tick <= 71 + 240; tick += 1) output = simulation.step(frame(tick, { released: tick === 71 ? Action.Fire : 0 }), TICK);
    expect(output.snapshot.camera.pitch).toBeLessThan(climbed);
    expect(output.snapshot.camera.pitch).toBeCloseTo(start, 3);
    simulation.dispose();
  });

  it('holds the climb for a moment before recovering', async () => {
    const simulation = await range();
    let output = simulation.step(frame(21, { held: Action.Fire, pressed: Action.Fire }), TICK);
    const kicked = output.snapshot.camera.pitch;
    // Inside the hold window nothing is handed back yet.
    const holdTicks = Math.floor(recoilHoldSeconds * 60) - 1;
    for (let tick = 22; tick <= 21 + holdTicks; tick += 1) output = simulation.step(frame(tick, { released: tick === 22 ? Action.Fire : 0 }), TICK);
    expect(output.snapshot.camera.pitch).toBeCloseTo(kicked, 6);
    simulation.dispose();
  });

  it('keeps a correction the player made while fighting the climb', async () => {
    const simulation = await range();
    const start = simulation.step(frame(21), TICK).snapshot.camera.pitch;
    // One shot, then pull down hard by more than the kick, then let it settle.
    simulation.step(frame(22, { held: Action.Fire, pressed: Action.Fire }), TICK);
    let output = simulation.step(frame(23, { look: [0, 60] }), TICK);
    for (let tick = 24; tick <= 24 + 240; tick += 1) output = simulation.step(frame(tick), TICK);
    // Recovery takes back only what recoil added, so the player's own pull survives it
    // rather than being undone.
    expect(output.snapshot.camera.pitch).toBeLessThan(start - 0.05);
    simulation.dispose();
  });

  it('kicks less while aiming, which is most of the reason to aim', async () => {
    const kick = async (aiming: boolean): Promise<number> => {
      const simulation = await range();
      const held = aiming ? Action.Fire | Action.Ads : Action.Fire;
      const before = simulation.step(frame(21, { held: aiming ? Action.Ads : 0 }), TICK).snapshot.camera.pitch;
      const after = simulation.step(frame(22, { held, pressed: Action.Fire }), TICK).snapshot.camera.pitch;
      simulation.dispose();
      return after - before;
    };
    const hip = await kick(false);
    const aimed = await kick(true);
    expect(aimed).toBeLessThan(hip);
    expect(aimed).toBeCloseTo(hip * recoilAdsFactor, 5);
  });

  it('resets the accumulator on a weapon swap', async () => {
    const simulation = await range();
    let output = simulation.step(frame(21, { held: Action.Fire, pressed: Action.Fire }), TICK);
    for (let tick = 22; tick <= 60; tick += 1) output = simulation.step(frame(tick, { held: Action.Fire }), TICK);
    const climbed = output.snapshot.camera.pitch;

    // A different weapon recovers at its own rate; carrying the accumulator across
    // would apply one gun's climb to another gun's curve.
    output = simulation.step(frame(61, { pressed: Action.WeaponSecondary }), TICK);
    for (let tick = 62; tick <= 200; tick += 1) output = simulation.step(frame(tick), TICK);
    expect(output.snapshot.camera.pitch).toBeCloseTo(climbed, 6);
    expect(output.snapshot.player.spreadBloom).toBe(0);
    simulation.dispose();
  });
});

describe('spread bloom', () => {
  it('grows with sustained fire and sheds when it stops', async () => {
    const simulation = await range();
    let output = simulation.step(frame(21, { held: Action.Fire, pressed: Action.Fire }), TICK);
    expect(output.snapshot.player.spreadBloom).toBeGreaterThan(0);
    for (let tick = 22; tick <= 90; tick += 1) output = simulation.step(frame(tick, { held: Action.Fire }), TICK);
    const bloomed = output.snapshot.player.spreadBloom;
    expect(bloomed).toBeGreaterThan(0.5);

    for (let tick = 91; tick <= 91 + 180; tick += 1) output = simulation.step(frame(tick, { released: tick === 91 ? Action.Fire : 0 }), TICK);
    expect(output.snapshot.player.spreadBloom).toBe(0);
    simulation.dispose();
  });

  it('is capped, so sustained fire cannot spray without limit', async () => {
    const simulation = await range();
    let output = simulation.step(frame(21, { held: Action.Fire, pressed: Action.Fire }), TICK);
    for (let tick = 22; tick <= 600; tick += 1) output = simulation.step(frame(tick, { held: Action.Fire }), TICK);
    expect(output.snapshot.player.spreadBloom).toBeLessThanOrEqual(1);
    simulation.dispose();
  });

  it('leaves the first round of a burst exactly where it was aimed', async () => {
    // Two runs of one shot each must land identically; bloom from that shot must not
    // widen the shot that produced it.
    const impactOf = async (): Promise<readonly number[]> => {
      const simulation = await range('dmr');
      const output = simulation.step(frame(21, { held: Action.Fire | Action.Ads, pressed: Action.Fire }), TICK);
      const impact = output.events.find((event) => event.kind === 'impact')!.position!;
      simulation.dispose();
      return impact;
    };
    expect(await impactOf()).toEqual(await impactOf());
  });
});

describe('crouch and slide', () => {
  it('shrinks the collider and lowers the eye', async () => {
    const simulation = await range();
    const standing = simulation.step(frame(21), TICK);
    expect(standing.snapshot.player.stance).toBe(0);

    let output = standing;
    for (let tick = 22; tick <= 80; tick += 1) output = simulation.step(frame(tick, { held: Action.Crouch }), TICK);
    expect(output.snapshot.player.stance).toBeCloseTo(1, 3);
    expect(output.snapshot.player.locomotion).toBe('crouching');
    // The eye drops with the stance, which is what makes a crouch worth anything.
    expect(output.snapshot.camera.position[1]).toBeLessThan(standing.snapshot.camera.position[1] - 0.2);
    simulation.dispose();
  });

  it('caps the crouched walk below the standing walk', async () => {
    const simulation = await range();
    for (let tick = 21; tick <= 80; tick += 1) simulation.step(frame(tick, { held: Action.Crouch }), TICK);
    let output = simulation.step(frame(81), TICK);
    for (let tick = 82; tick <= 140; tick += 1) {
      output = simulation.step(frame(tick, { held: Action.Crouch | Action.Forward | Action.Sprint }), TICK);
    }
    // Sprint is held and deliberately ignored while crouched.
    expect(output.snapshot.player.speed).toBeLessThanOrEqual(movementProfile.crouchSpeed + 0.01);
    expect(output.snapshot.player.speed).toBeGreaterThan(0);
    simulation.dispose();
  });

  it('stands back up when the crouch is released', async () => {
    const simulation = await range();
    for (let tick = 21; tick <= 80; tick += 1) simulation.step(frame(tick, { held: Action.Crouch }), TICK);
    let output = simulation.step(frame(81, { released: Action.Crouch }), TICK);
    for (let tick = 82; tick <= 140; tick += 1) output = simulation.step(frame(tick), TICK);
    expect(output.snapshot.player.stance).toBeCloseTo(0, 3);
    expect(output.snapshot.player.locomotion).toBe('grounded');
    simulation.dispose();
  });

  it('refuses to stand up under a low ceiling', async () => {
    const clearance = playerCapsule.crouchedHalfHeight + playerCapsule.radius + 0.15;
    const build = defaultBuildFor('carbine', 'test', 'Test');
    const simulation = new FlowSimulation(undefined, [build, build]);
    // A slab just above a crouched crown, so standing would clip through it.
    await simulation.loadLevel(cookLevel(flat([{
      id: 'ceiling', kind: 'box', color: '#333', collision: true, surface: 'no-traverse',
      transform: { position: [0, 1 + clearance + 0.5, 0], rotation: [0, 0, 0], scale: [8, 1, 8] },
    }])));
    for (let tick = 1; tick <= 90; tick += 1) simulation.step(frame(tick, { held: Action.Crouch }), TICK);

    let output = simulation.step(frame(91, { released: Action.Crouch }), TICK);
    for (let tick = 92; tick <= 200; tick += 1) output = simulation.step(frame(tick), TICK);
    // Held down by the geometry rather than popping through it.
    expect(output.snapshot.player.stance).toBeGreaterThan(0.9);
    simulation.dispose();
  });

  it('gains speed sliding downhill and only coasts on the flat', async () => {
    const slideOn = async (rotationX: number): Promise<number> => {
      const build = defaultBuildFor('carbine', 'test', 'Test');
      const simulation = new FlowSimulation(undefined, [build, build]);
      // Centred on the spawn: rotating a box about its own centre leaves that point
      // fixed, so the player still starts resting on the surface whatever the tilt.
      await simulation.loadLevel(cookLevel({
        ...flat(),
        primitives: [{
          id: 'ramp', kind: 'ramp', color: '#fff', collision: true, surface: 'default',
          transform: { position: [0, -0.5, 0], rotation: [rotationX, 0, 0], scale: [24, 1, 90] },
        }],
      }));
      // Build up speed, then slide.
      let output = simulation.step(frame(1), TICK);
      for (let tick = 2; tick <= 60; tick += 1) output = simulation.step(frame(tick, { held: Action.Forward | Action.Sprint }), TICK);
      output = simulation.step(frame(61, { held: Action.Forward | Action.Sprint | Action.Crouch, pressed: Action.Crouch }), TICK);
      let peak = output.snapshot.player.speed;
      for (let tick = 62; tick <= 100; tick += 1) {
        output = simulation.step(frame(tick, { held: Action.Forward | Action.Sprint | Action.Crouch }), TICK);
        peak = Math.max(peak, output.snapshot.player.speed);
      }
      simulation.dispose();
      return peak;
    };

    const downhill = await slideOn(-0.3);
    const level = await slideOn(0);
    // A slide is a movement tool on a slope, not just a one-shot 1.25x boost.
    expect(downhill).toBeGreaterThan(level);
  });
});
