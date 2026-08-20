import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitySnapshot, GameEvent, SimulationSnapshot } from '../src/contracts';
import { CharacterPresenter } from '../src/render/presentation/CharacterPresenter';
import type { MaterialLibrary } from '../src/render/presentation/MaterialLibrary';

interface TestHunterInstance {
  root: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  currentClip: string | null;
  healthRoot: THREE.Group;
  ownedGeometries: THREE.BufferGeometry[];
  ownedMaterials: THREE.Material[];
  deathMaterials: THREE.Material[];
}

const presenters: CharacterPresenter[] = [];

afterEach(() => {
  for (const presenter of presenters.splice(0)) presenter.dispose();
  vi.restoreAllMocks();
});

describe('CharacterPresenter resource lifecycle', () => {
  it('isolates death opacity from shared template materials and releases instance resources', () => {
    const presenter = createPresenter();
    const shared = new THREE.MeshStandardMaterial({ color: '#8899aa', opacity: 1 });
    const template = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    body.name = 'external-body';
    template.add(body);
    presenter.setExternalTemplate('ranged', template, hunterClips());
    presenter.update(snapshot(0, [bot()]), 0, 1 / 60, 1);

    const instance = getInstance(presenter, 7);
    const mixer = instance.mixer!;
    const stop = vi.spyOn(mixer, 'stopAllAction');
    const uncache = vi.spyOn(mixer, 'uncacheRoot');
    const healthGeometryDisposals = instance.ownedGeometries.map((resource) => vi.spyOn(resource, 'dispose'));
    const healthMaterialDisposals = instance.ownedMaterials.map((resource) => vi.spyOn(resource, 'dispose'));

    presenter.consume([event('kill', 1, { targetEntityId: 7 })], 300);
    const isolated = instance.root.getObjectByName('external-body') as THREE.Mesh;
    expect(isolated.material).not.toBe(shared);
    expect(instance.deathMaterials).toContain(isolated.material);
    const deathDisposal = vi.spyOn(isolated.material as THREE.Material, 'dispose');

    presenter.update(snapshot(25), 999, 1 / 60, 1);
    expect(shared.opacity).toBe(1);
    expect(shared.transparent).toBe(false);
    expect((isolated.material as THREE.Material).opacity).toBeLessThan(1);

    presenter.update(snapshot(49), 9999, 1 / 60, 1);
    expect(stop).toHaveBeenCalledOnce();
    expect(uncache).toHaveBeenCalledWith(instance.root);
    expect(deathDisposal).toHaveBeenCalledOnce();
    healthGeometryDisposals.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
    healthMaterialDisposals.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
    expect(presenter.root.children).toHaveLength(0);

    body.geometry.dispose();
    shared.dispose();
  });

  it.each(['replacement', 'clear', 'despawn', 'dispose'] as const)(
    'uses the centralized disposer on %s',
    (removal) => {
      const presenter = createPresenter();
      const template = new THREE.Group();
      template.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
      presenter.setExternalTemplate('ranged', template, hunterClips());
      presenter.update(snapshot(0, [bot()]), 0, 1 / 60, 1);
      const instance = getInstance(presenter, 7);
      const mixer = instance.mixer!;
      const stop = vi.spyOn(mixer, 'stopAllAction');
      const uncache = vi.spyOn(mixer, 'uncacheRoot');
      const geometryDispose = vi.spyOn(instance.ownedGeometries[0]!, 'dispose');
      const materialDispose = vi.spyOn(instance.ownedMaterials[0]!, 'dispose');

      if (removal === 'replacement') presenter.setExternalTemplate('ranged', new THREE.Group(), hunterClips());
      else if (removal === 'clear') presenter.clearExternalTemplates();
      else if (removal === 'despawn') presenter.update(snapshot(1), 1, 1 / 60, 1);
      else presenter.dispose();

      expect(stop).toHaveBeenCalledOnce();
      expect(uncache).toHaveBeenCalledWith(instance.root);
      expect(geometryDispose).toHaveBeenCalledOnce();
      expect(materialDispose).toHaveBeenCalledOnce();
      expect(presenter.root.children).toHaveLength(0);

      template.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
    },
  );
});

describe('CharacterPresenter clip routing', () => {
  it('selects deterministic movement, attack, and hit clips from snapshots and events', () => {
    const presenter = createPresenter();
    presenter.setExternalTemplate('ranged', new THREE.Group(), hunterClips());

    presenter.update(snapshot(1, [bot({ velocity: [4, 0, 0] })]), 400, 1 / 60, 1);
    expect(getInstance(presenter, 7).currentClip).toBe('hunter_strafe_r');

    presenter.update(snapshot(2, [bot({ grounded: false, velocity: [0, -2, 0] })]), 0, 1 / 60, 1);
    expect(getInstance(presenter, 7).currentClip).toBe('hunter_drop');

    presenter.consume([event('enemyAttack', 3, { sourceEntityId: 7, targetEntityId: 1 })], 1000);
    presenter.update(snapshot(3, [bot()]), -200, 1 / 60, 1);
    expect(getInstance(presenter, 7).currentClip).toBe('hunter_fire');

    presenter.consume([event('hit', 4, { sourceEntityId: 1, targetEntityId: 7 })], -1000);
    presenter.update(snapshot(4, [bot()]), 5000, 1 / 60, 1);
    expect(getInstance(presenter, 7).currentClip).toBe('hunter_hit');
  });
});

function createPresenter(): CharacterPresenter {
  const shared = new Map<string, THREE.MeshStandardMaterial>();
  const library = {
    get(name: string): THREE.MeshStandardMaterial {
      let material = shared.get(name);
      if (!material) {
        material = new THREE.MeshStandardMaterial({ color: '#607080' });
        shared.set(name, material);
      }
      return material;
    },
    variant(_base: string, color: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
      return new THREE.MeshStandardMaterial({ color });
    },
  } as unknown as MaterialLibrary;
  const presenter = new CharacterPresenter(library);
  presenters.push(presenter);
  return presenter;
}

function getInstance(presenter: CharacterPresenter, id: number): TestHunterInstance {
  const instances = (presenter as unknown as { instances: Map<number, TestHunterInstance> }).instances;
  const instance = instances.get(id);
  if (!instance) throw new Error(`Missing hunter instance ${id}.`);
  return instance;
}

function hunterClips(): THREE.AnimationClip[] {
  return [
    'hunter_idle',
    'hunter_run',
    'hunter_strafe_l',
    'hunter_strafe_r',
    'hunter_fire',
    'hunter_melee',
    'hunter_hit',
    'hunter_death',
    'hunter_jump',
    'hunter_drop',
    'hunter_land',
  ].map((name) => new THREE.AnimationClip(name, 0.4, []));
}

function bot(overrides: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return {
    id: 7,
    kind: 'bot',
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    rotationY: 0,
    grounded: true,
    aimPitch: 0,
    health: 100,
    maxHealth: 100,
    profile: 'ranged',
    ...overrides,
  };
}

function snapshot(tick: number, entities: EntitySnapshot[] = []): SimulationSnapshot {
  return {
    tick,
    elapsedSeconds: tick / 60,
    entities,
    camera: { position: [0, 1, 0], yaw: 0, pitch: 0, fov: 90 },
    player: {
      health: 100,
      ammo: 30,
      reserveAmmo: 90,
      magazineSize: 30,
      weapons: { activeSlot: 0, ready: true, slots: [
        { name: 'Carbine', chassisId: 'carbine' as const, parts: {}, ammo: 30, reserveAmmo: 120 },
        { name: 'SMG', chassisId: 'smg' as const, parts: {}, ammo: 40, reserveAmmo: 180 },
      ] },
      locomotion: 'grounded',
      action: 'neutral',
      adsProgress: 0,
      actionProgress: 0,
      spreadBloom: 0,
      stance: 0,
      speed: 0,
      airCharge: 1,
      grapple: { active: false, anchor: null, ropeLength: 0, cooldown: 0, available: true, aim: null },
      dashAvailable: true,
      dodge: { invulnerable: false, ready: true, cooldown: 0 },
      jumpCancelAvailable: false,
      wallJumpAvailable: false,
      lockedTargetId: null,
      score: 0,
      combo: { links: 0, multiplier: 1, window: 0, peakLinks: 0 },
      deaths: 0,
      awaitingRespawn: false,
    },
    splits: [],
    objective: '',
    completed: false,
    openGateIds: [],
  };
}

function event(kind: GameEvent['kind'], tick: number, details: Partial<GameEvent>): GameEvent {
  return { id: tick, tick, kind, ...details };
}
