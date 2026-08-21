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
  it('starts on the blade with both slots loaded from their own stats', async () => {
    const simulation = await start([carbine, dmr]);
    const output = simulation.step(frame(1), TICK);
    const weapons = output.snapshot.player.weapons;
    // The blade is the primary verb, so it is what a run starts in the player's hands;
    // the first gun slot is merely the one that would come up if they asked for a gun.
    expect(weapons.inHand).toBe('blade');
    expect(weapons.activeSlot).toBe(0);
    expect(weapons.slots.map((slot) => slot.name)).toEqual(['Carbine', 'DMR']);
    expect(weapons.slots[0].ammo).toBe(resolveWeaponStats(carbine).magazineSize);
    expect(weapons.slots[1].ammo).toBe(resolveWeaponStats(dmr).magazineSize);
    expect(output.snapshot.player.magazineSize).toBe(resolveWeaponStats(carbine).magazineSize);
    simulation.dispose();
  });

  it('selects each of the three directly, and cycles them in the same order', async () => {
    const simulation = await start([carbine, dmr]);
    let output = simulation.step(frame(1, { pressed: Action.SelectGunOne }), TICK);
    expect(output.snapshot.player.weapons.inHand).toBe('gun');
    expect(output.snapshot.player.weapons.activeSlot).toBe(0);
    expect(output.snapshot.player.magazineSize).toBe(resolveWeaponStats(carbine).magazineSize);

    output = simulation.step(frame(2, { pressed: Action.SelectGunTwo }), TICK);
    expect(output.snapshot.player.weapons.activeSlot).toBe(1);
    expect(output.snapshot.player.magazineSize).toBe(resolveWeaponStats(dmr).magazineSize);

    output = simulation.step(frame(3, { pressed: Action.SelectBlade }), TICK);
    expect(output.snapshot.player.weapons.inHand).toBe('blade');

    // The swap key walks the same three in the same order the keys are in, so a player
    // who never learns the numbers still gets a predictable rotation.
    output = simulation.step(frame(4, { pressed: Action.WeaponSwap }), TICK);
    expect(output.snapshot.player.weapons).toMatchObject({ inHand: 'gun', activeSlot: 0 });
    output = simulation.step(frame(5, { pressed: Action.WeaponSwap }), TICK);
    expect(output.snapshot.player.weapons).toMatchObject({ inHand: 'gun', activeSlot: 1 });
    output = simulation.step(frame(6, { pressed: Action.WeaponSwap }), TICK);
    expect(output.snapshot.player.weapons.inHand).toBe('blade');
    simulation.dispose();
  });

  it('blocks firing until the swapped weapon is ready', async () => {
    const simulation = await start([carbine, dmr]);
    // Drawing a gun from the blade is a change of hands and costs nothing. Swapping one
    // gun for another is the move that has to be paid for, and this is that move.
    let output = simulation.step(frame(1, { pressed: Action.SelectGunOne }), TICK);
    expect(output.snapshot.player.weapons.ready).toBe(true);
    output = simulation.step(frame(2, { pressed: Action.SelectGunTwo }), TICK);
    expect(output.snapshot.player.weapons.ready).toBe(false);

    output = simulation.step(frame(3, { held: Action.Attack, pressed: Action.Attack }), TICK);
    expect(output.events.some((event) => event.kind === 'shot')).toBe(false);
    expect(output.snapshot.player.weapons.slots[1].ammo).toBe(resolveWeaponStats(dmr).magazineSize);

    for (let tick = 4; tick < 40; tick += 1) output = simulation.step(frame(tick), TICK);
    expect(output.snapshot.player.weapons.ready).toBe(true);
    output = simulation.step(frame(40, { held: Action.Attack, pressed: Action.Attack }), TICK);
    expect(output.events.some((event) => event.kind === 'shot')).toBe(true);
    simulation.dispose();
  });

  it('spends ammo from the active slot only', async () => {
    const simulation = await start([carbine, dmr]);
    let output = simulation.step(frame(1, { held: Action.Attack, pressed: Action.Attack | Action.SelectGunOne }), TICK);
    for (let tick = 2; tick < 40; tick += 1) output = simulation.step(frame(tick, { held: Action.Attack }), TICK);
    const slots = output.snapshot.player.weapons.slots;
    expect(slots[0].ammo).toBeLessThan(resolveWeaponStats(carbine).magazineSize);
    expect(slots[1].ammo).toBe(resolveWeaponStats(dmr).magazineSize);
    simulation.dispose();
  });

  it('rewinds both slots, the active slot and what was in hand on a checkpoint restore', async () => {
    const simulation = await start([carbine, dmr]);
    let output = simulation.step(frame(1, { held: Action.Attack, pressed: Action.Attack | Action.SelectGunOne }), TICK);
    for (let tick = 2; tick < 30; tick += 1) output = simulation.step(frame(tick, { held: Action.Attack }), TICK);
    output = simulation.step(frame(30, { pressed: Action.SelectGunTwo }), TICK);
    expect(output.snapshot.player.weapons.slots[0].ammo).toBeLessThan(resolveWeaponStats(carbine).magazineSize);
    expect(output.snapshot.player.weapons.activeSlot).toBe(1);

    // The checkpoint was taken at spawn, so restoring returns both slots to full and
    // puts the blade back in hand -- a restore must not rearm the player differently
    // from how they started.
    simulation.restoreCheckpoint();
    output = simulation.step(frame(31), TICK);
    expect(output.snapshot.player.weapons.slots[0].ammo).toBe(resolveWeaponStats(carbine).magazineSize);
    expect(output.snapshot.player.weapons.slots[1].ammo).toBe(resolveWeaponStats(dmr).magazineSize);
    expect(output.snapshot.player.weapons.inHand).toBe('blade');
    expect(output.snapshot.player.weapons.activeSlot).toBe(0);
    expect(output.snapshot.player.weapons.ready).toBe(true);
    simulation.dispose();
  });
});

describe('chassis behaviour', () => {
  it('fires one trace per pellet so a shotgun spreads', async () => {
    const simulation = await start([shotgun, carbine]);
    const output = simulation.step(frame(1, { held: Action.Attack, pressed: Action.Attack | Action.SelectGunOne }), TICK);
    const shots = output.events.filter((event) => event.kind === 'shot');
    const impacts = output.events.filter((event) => event.kind === 'impact');
    expect(shots).toHaveLength(1);
    expect(impacts).toHaveLength(resolveWeaponStats(shotgun).pellets);
    simulation.dispose();
  });

  it('applies the chassis ADS zoom to the camera', async () => {
    const wide = await start([shotgun, carbine]);
    const narrow = await start([dmr, carbine]);
    // Sights belong to a gun, so the gun has to be up for there to be any zoom at all.
    const wideFov = wide.step(frame(1, { held: Action.Ads, pressed: Action.SelectGunOne }), TICK).snapshot.camera.fov;
    const narrowFov = narrow.step(frame(1, { held: Action.Ads, pressed: Action.SelectGunOne }), TICK).snapshot.camera.fov;
    expect(narrowFov).toBeLessThan(wideFov);
    wide.dispose();
    narrow.dispose();
  });

  it('reloads to the active weapon capacity', async () => {
    const simulation = await start([dmr, carbine]);
    let output = simulation.step(frame(1, { held: Action.Attack, pressed: Action.Attack | Action.SelectGunOne }), TICK);
    for (let tick = 2; tick < 20; tick += 1) output = simulation.step(frame(tick, { held: Action.Attack }), TICK);
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
