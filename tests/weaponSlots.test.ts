import { describe, expect, it } from 'vitest';
import { Action, type InputFrame, type LegacyLevelDocumentV1, type LevelPrimitive, type Vec3, type WeaponBuild } from '../src/contracts';
import { cookLevel } from '../src/content/defaultLevel';
import { defaultBuildFor, resolveWeaponStats } from '../src/content/weapons';
import { FlowSimulation } from '../src/simulation/FlowSimulation';

const TICK = 1 / 60;

function box(id: string, position: Vec3, scale: Vec3): LevelPrimitive {
  return { id, kind: 'box', transform: { position, rotation: [0, 0, 0], scale }, color: '#889', collision: true, surface: 'default' };
}

const FLOOR = box('floor', [0, -0.5, -20], [40, 1, 80]);

function frame(tick: number, patch: Partial<InputFrame> = {}): InputFrame {
  return { tick, held: 0, pressed: 0, released: 0, look: [0, 0], ...patch };
}

async function start(loadout: readonly WeaponBuild[], primitives: LevelPrimitive[] = [FLOOR], withBot = false): Promise<FlowSimulation> {
  const document: LegacyLevelDocumentV1 = {
    schemaVersion: 1, id: 'weapons', name: 'Weapons', units: 'meters',
    primitives,
    spawns: [
      { id: 'player', kind: 'player', position: [0, 1, 4], rotationY: 0 },
      ...(withBot ? [{ id: 'guard', kind: 'bot-ranged' as const, position: [0, 1, -8] as Vec3, rotationY: 0 }] : []),
    ],
    encounters: [], offMeshLinks: [], exit: [0, 1, -200],
  };
  const simulation = new FlowSimulation(undefined, loadout);
  await simulation.loadLevel(cookLevel(document));
  return simulation;
}

const carbine = defaultBuildFor('carbine', 'a', 'Carbine');
const dmr = defaultBuildFor('dmr', 'b', 'DMR');
const shotgun = defaultBuildFor('shotgun', 'c', 'Shotgun');

describe('two-slot loadout', () => {
  it('starts on the primary with both slots loaded from their own stats', async () => {
    const simulation = await start([carbine, dmr]);
    const output = simulation.step(frame(1), TICK);
    const weapons = output.snapshot.player.weapons;
    expect(weapons.activeSlot).toBe(0);
    expect(weapons.slots.map((slot) => slot.name)).toEqual(['Carbine', 'DMR']);
    expect(weapons.slots[0].ammo).toBe(resolveWeaponStats(carbine).magazineSize);
    expect(weapons.slots[1].ammo).toBe(resolveWeaponStats(dmr).magazineSize);
    expect(output.snapshot.player.magazineSize).toBe(resolveWeaponStats(carbine).magazineSize);
    simulation.dispose();
  });

  it('selects a slot directly and toggles with the swap key', async () => {
    const simulation = await start([carbine, dmr]);
    let output = simulation.step(frame(1, { pressed: Action.WeaponSecondary }), TICK);
    expect(output.snapshot.player.weapons.activeSlot).toBe(1);
    expect(output.snapshot.player.magazineSize).toBe(resolveWeaponStats(dmr).magazineSize);

    output = simulation.step(frame(2, { pressed: Action.WeaponPrimary }), TICK);
    expect(output.snapshot.player.weapons.activeSlot).toBe(0);

    output = simulation.step(frame(3, { pressed: Action.WeaponSwap }), TICK);
    expect(output.snapshot.player.weapons.activeSlot).toBe(1);
    output = simulation.step(frame(4, { pressed: Action.WeaponSwap }), TICK);
    expect(output.snapshot.player.weapons.activeSlot).toBe(0);
    simulation.dispose();
  });

  it('blocks firing until the swapped weapon is ready', async () => {
    const simulation = await start([carbine, dmr]);
    let output = simulation.step(frame(1, { pressed: Action.WeaponSecondary }), TICK);
    expect(output.snapshot.player.weapons.ready).toBe(false);

    output = simulation.step(frame(2, { held: Action.Fire, pressed: Action.Fire }), TICK);
    expect(output.events.some((event) => event.kind === 'shot')).toBe(false);
    expect(output.snapshot.player.weapons.slots[1].ammo).toBe(resolveWeaponStats(dmr).magazineSize);

    for (let tick = 3; tick < 40; tick += 1) output = simulation.step(frame(tick), TICK);
    expect(output.snapshot.player.weapons.ready).toBe(true);
    output = simulation.step(frame(40, { held: Action.Fire, pressed: Action.Fire }), TICK);
    expect(output.events.some((event) => event.kind === 'shot')).toBe(true);
    simulation.dispose();
  });

  it('spends ammo from the active slot only', async () => {
    const simulation = await start([carbine, dmr]);
    let output = simulation.step(frame(1, { held: Action.Fire, pressed: Action.Fire }), TICK);
    for (let tick = 2; tick < 40; tick += 1) output = simulation.step(frame(tick, { held: Action.Fire }), TICK);
    const slots = output.snapshot.player.weapons.slots;
    expect(slots[0].ammo).toBeLessThan(resolveWeaponStats(carbine).magazineSize);
    expect(slots[1].ammo).toBe(resolveWeaponStats(dmr).magazineSize);
    simulation.dispose();
  });

  it('rewinds both slots and the active slot on a checkpoint restore', async () => {
    const simulation = await start([carbine, dmr]);
    let output = simulation.step(frame(1, { held: Action.Fire, pressed: Action.Fire }), TICK);
    for (let tick = 2; tick < 30; tick += 1) output = simulation.step(frame(tick, { held: Action.Fire }), TICK);
    output = simulation.step(frame(30, { pressed: Action.WeaponSecondary }), TICK);
    expect(output.snapshot.player.weapons.slots[0].ammo).toBeLessThan(resolveWeaponStats(carbine).magazineSize);
    expect(output.snapshot.player.weapons.activeSlot).toBe(1);

    // The checkpoint was taken at spawn, so restoring returns both slots to full
    // and puts the primary back in hand.
    simulation.restoreCheckpoint();
    output = simulation.step(frame(31), TICK);
    expect(output.snapshot.player.weapons.slots[0].ammo).toBe(resolveWeaponStats(carbine).magazineSize);
    expect(output.snapshot.player.weapons.slots[1].ammo).toBe(resolveWeaponStats(dmr).magazineSize);
    expect(output.snapshot.player.weapons.activeSlot).toBe(0);
    expect(output.snapshot.player.weapons.ready).toBe(true);
    simulation.dispose();
  });
});

describe('chassis behaviour', () => {
  it('fires one trace per pellet so a shotgun spreads', async () => {
    const simulation = await start([shotgun, carbine]);
    const output = simulation.step(frame(1, { held: Action.Fire, pressed: Action.Fire }), TICK);
    const shots = output.events.filter((event) => event.kind === 'shot');
    const impacts = output.events.filter((event) => event.kind === 'impact');
    expect(shots).toHaveLength(1);
    expect(impacts).toHaveLength(resolveWeaponStats(shotgun).pellets);
    simulation.dispose();
  });

  it('applies the chassis ADS zoom to the camera', async () => {
    const wide = await start([shotgun, carbine]);
    const narrow = await start([dmr, carbine]);
    const wideFov = wide.step(frame(1, { held: Action.Ads }), TICK).snapshot.camera.fov;
    const narrowFov = narrow.step(frame(1, { held: Action.Ads }), TICK).snapshot.camera.fov;
    expect(narrowFov).toBeLessThan(wideFov);
    wide.dispose();
    narrow.dispose();
  });

  it('reloads to the active weapon capacity', async () => {
    const simulation = await start([dmr, carbine]);
    let output = simulation.step(frame(1, { held: Action.Fire, pressed: Action.Fire }), TICK);
    for (let tick = 2; tick < 20; tick += 1) output = simulation.step(frame(tick, { held: Action.Fire }), TICK);
    const afterBurst = output.snapshot.player.weapons.slots[0].ammo;
    expect(afterBurst).toBeLessThan(resolveWeaponStats(dmr).magazineSize);

    output = simulation.step(frame(20, { pressed: Action.Reload }), TICK);
    expect(output.snapshot.player.action).toBe('reloading');
    for (let tick = 21; tick < 200; tick += 1) {
      output = simulation.step(frame(tick), TICK);
      if (output.events.some((event) => event.kind === 'reloadComplete')) break;
    }
    expect(output.snapshot.player.weapons.slots[0].ammo).toBe(resolveWeaponStats(dmr).magazineSize);
    simulation.dispose();
  });
});
