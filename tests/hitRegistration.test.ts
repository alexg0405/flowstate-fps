import { describe, expect, it } from 'vitest';
import { Action, type LegacyLevelDocumentV1 } from '../src/contracts';
import { botCapsule, botColliderBottom } from '../src/content/config';
import { cookLevel } from '../src/content/defaultLevel';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;
/** Height of the authored hunter models, whose origin sits at their feet. */
const MODEL_HEIGHT = 2.06;

const document: LegacyLevelDocumentV1 = {
  schemaVersion: 1, id: 'hits', name: 'Hits', units: 'meters',
  primitives: [{
    id: 'floor', kind: 'box', color: '#889', collision: true, surface: 'default',
    transform: { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [80, 1, 80] },
  }],
  spawns: [
    { id: 'player', kind: 'player', position: [0, 1, 18], rotationY: 0 },
    { id: 'guard', kind: 'bot-ranged', position: [0, 1, 0], rotationY: 0 },
  ],
  encounters: [], offMeshLinks: [], exit: [0, 1, -200],
};

/** Fires a single aimed shot at a fraction of the bot's visible height. */
async function shootAtBodyFraction(fraction: number) {
  const simulation = new FlowSimulation();
  await simulation.loadLevel(cookLevel(document));
  let output = simulation.step({ tick: 1, held: 0, pressed: 0, released: 0, look: [0, 0] }, TICK);
  for (let tick = 2; tick < 26; tick += 1) {
    output = simulation.step({ tick, held: 0, pressed: 0, released: 0, look: [0, 0] }, TICK);
  }
  const bot = output.snapshot.entities.find((entity) => entity.kind === 'bot')!;
  const camera = output.snapshot.camera.position;
  const targetY = bot.position[1] - botColliderBottom + fraction * MODEL_HEIGHT;
  const dx = bot.position[0] - camera[0];
  const dz = bot.position[2] - camera[2];
  const flat = Math.hypot(dx, dz);
  output = simulation.step({
    tick: 30,
    held: Action.Attack | Action.Ads,
    // The gun is a selection now, and drawing it resolves before the trigger is read on
    // the same tick.
    pressed: Action.Attack | Action.SelectGunOne,
    released: 0,
    look: [
      (output.snapshot.camera.yaw - Math.atan2(-dx, -dz)) / 0.002,
      (output.snapshot.camera.pitch - Math.atan2(targetY - camera[1], flat)) / 0.002,
    ],
  }, TICK);
  const impact = output.events.find((event) => event.kind === 'impact');
  simulation.dispose();
  return { hit: impact?.targetEntityId !== undefined, headshot: impact?.headshot === true };
}

describe('bot hit registration', () => {
  it('covers the whole visible model with collider', () => {
    // The models stand 2.06 m tall from their feet, so the capsule must too, or
    // shots that visually land on the torso pass through empty space.
    expect((botCapsule.halfHeight + botCapsule.radius) * 2).toBeCloseTo(MODEL_HEIGHT, 2);
  });

  it('registers hits along the full height of the body', async () => {
    for (const fraction of [0.1, 0.25, 0.45, 0.68, 0.85, 0.95]) {
      const { hit } = await shootAtBodyFraction(fraction);
      expect(hit, `body fraction ${fraction} should register`).toBe(true);
    }
  }, 60_000);

  it('counts the top of the model as a headshot and the torso as a body shot', async () => {
    expect((await shootAtBodyFraction(0.95)).headshot).toBe(true);
    expect((await shootAtBodyFraction(0.5)).headshot).toBe(false);
  }, 60_000);

  it('misses cleanly above and below the body', async () => {
    expect((await shootAtBodyFraction(1.4)).hit).toBe(false);
    expect((await shootAtBodyFraction(-0.6)).hit).toBe(false);
  }, 60_000);
});
