import RAPIER, { type Collider, type KinematicCharacterController, type RigidBody, type World } from '@dimforge/rapier3d-compat';
import {
  Action,
  type ActionState,
  type BotProfile,
  type CheckpointState,
  type ComboLinkKind,
  type GameEvent,
  type RunModifier,
  type RunSplit,
  type GameSimulation,
  type InputFrame,
  type CollisionPrimitiveV2,
  type LocomotionState,
  type RuntimeLevelV1,
  type SaveDataV1,
  type SimulationOutput,
  type SimulationSnapshot,
  type SpawnDefinition,
  type TraversalFlags,
  type BladeStyleDefinition,
  type BladeStyleId,
  type WeaponBuild,
  type WeaponDefinition,
  type Vec3,
} from '../contracts';
import { aimAssist, botCapsule, botColliderBottom, botLeashMetres, botProfiles, comboScoring, dodge, lifestealForKill, movementProfile, playerCapsule, playerHealth, recoilAdsFactor, recoilHoldSeconds, runScoring } from '../content/config';
import { bladeStyle } from '../content/blades';
import { chassisMultiplier } from '../content/modifiers';
import { defaultArmory, resolveWeaponStats } from '../content/weapons';
import { NavigationService } from '../navigation/NavigationService';
import { approach, consumeAirCharge, resetFromGround, resetFromWall, type SurfaceResetState } from './movementRules';
import { hashSeed, SeededRandom } from './random';

interface BotState {
  id: number;
  spawnId: string;
  profile: BotProfile;
  body: RigidBody;
  collider: Collider;
  health: number;
  fireCooldown: number;
  decisionCooldown: number;
  strafe: number;
  alive: boolean;
  spawnPosition: Vec3;
  waypoint: Vec3 | null;
  encounterId?: string;
  /** Which wave of its encounter it belongs to. Waves activate one at a time. */
  wave: number;
  active: boolean;
  velocityY: number;
  velocity: { x: number; y: number; z: number };
  grounded: boolean;
  /** Time left in the telegraph before the committed shot resolves. */
  windupTimer: number;
  /** Aim error picked when the shot was committed, so the telegraph cannot be re-rolled. */
  windupSpread: number;
  /**
   * Where the bot is pointed, as a yaw whose forward is `(sin, cos)`. Only matters
   * for a profile that has a turn rate; the rest snap to the player, which is what
   * the snapshot used to compute inline every frame.
   */
  facingYaw: number;
}

interface WeaponSlotState {
  build: WeaponBuild;
  stats: WeaponDefinition;
  ammo: number;
  reserveAmmo: number;
}

interface PlayerState extends SurfaceResetState {
  id: number;
  body: RigidBody;
  collider: Collider;
  velocity: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  health: number;
  weapons: WeaponSlotState[];
  activeSlot: number;
  weaponReadyTimer: number;
  locomotion: LocomotionState;
  action: ActionState;
  dashTimer: number;
  dashElapsed: number;
  dashWasGrounded: boolean;
  /** Time left on the dash's invulnerability frames. Nothing incoming lands above 0. */
  invulnerableTimer: number;
  /** Time left before a dash may arm the frames again. */
  dodgeCooldown: number;
  jumpTapTimer: number;
  slideTimer: number;
  vaultTimer: number;
  coyoteTimer: number;
  jumpBuffer: number;
  fireCooldown: number;
  reloadTimer: number;
  meleeTimer: number;
  /** Recovery the live swing was given, so progress can be reported against it. */
  meleeDuration: number;
  score: number;
  ads: boolean;
  grounded: boolean;
  grappleAnchor: Vec3 | null;
  grappleColliderHandle: number | null;
  grappleRopeLength: number;
  grapplePullTimer: number;
  grapplePullBoost: number;
  grappleStallTimer: number;
  grappleCooldown: number;
  lockedTargetId: number | null;
  wallJumpReady: boolean;
  /** Set once per trigger pull, so an empty weapon clicks once rather than per tick. */
  dryFireReported: boolean;
  /**
   * Which of the three carried weapons is in the player's hands. See `Action.SelectBlade`.
   *
   * This was a 0.95 s timer refreshed by firing -- the blade came back on its own, which
   * meant the attack button changed meaning underneath a player who had not asked for
   * anything. It is a choice now, and it holds until the next one.
   */
  inHand: 'blade' | 'gun';
  /**
   * Unused remnant of the old timer, kept out of the state entirely. See `inHand`.
   * the player holds, the gun comes up when it is used and drops away again, and this is
   * the only copy of that decision -- the viewmodel and the HUD both read it now.
   */

  comboLinks: number;
  comboTimer: number;
  /** Movement tech already spent on the current chain. */
  comboKinds: ComboLinkKind[];
  /** View offset recoil has added and not yet handed back, in radians. */
  recoilPitch: number;
  recoilYaw: number;
  /** Time left before recovery resumes. */
  recoilHold: number;
  /** Spread multiplier accumulated by sustained fire. */
  bloom: number;
  /** 0 standing, 1 fully crouched. Interpolated so the stance change is not a snap. */
  stance: number;
}

const UP = { x: 0, y: 1, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };
/** Distance from a bot capsule's centre to its feet. */
const BOT_COLLIDER_BOTTOM = botColliderBottom;
/** How far above an authored spawn the grounding probe starts. */
const BOT_SPAWN_PROBE = 2;
/** Drop a bot will willingly step down without a navmesh telling it to. */
const BOT_MAX_DROP = 1.6;
/** How far ahead of the capsule centre the ledge probe is taken. Must exceed the
 * capsule radius so a bot stops before its support is gone. */
const BOT_LEDGE_LOOKAHEAD = 0.7;
/** Anything below this has left the level and is returned or killed. */
const VOID_Y = -20;
/** The player's full health, and what the snapshot reports their bar against. */
const PLAYER_MAX_HEALTH = playerHealth;
const WEAPON_SWAP_SECONDS = 0.34;
/** Closing distance per tick below which the pull counts as stalled. */
const GRAPPLE_PROGRESS_EPSILON = 0.004;
const GRAPPLE_STALL_SECONDS = 0.35;
/** Height above the capsule centre that counts as a head hit. */
const BOT_HEADSHOT_HEIGHT = 0.62;
/** Height above the capsule centre a bot's shots leave from. */
const BOT_MUZZLE_HEIGHT = 0.45;
/** Multiple of the firing distance a bot's trace is allowed to travel. */
const BOT_SHOT_RANGE_FACTOR = 3;
const PLAYER_CAPSULE_RADIUS = playerCapsule.radius;
/** Clearance above the crouched crown needed before the player may stand up. */
const STAND_CLEARANCE = (playerCapsule.standingHalfHeight - playerCapsule.crouchedHalfHeight) * 2 + 0.08;
let rapierInitialization: Promise<void> | null = null;

function initializeRapier(): Promise<void> {
  rapierInitialization ??= RAPIER.init();
  return rapierInitialization;
}

export class FlowSimulation implements GameSimulation {
  private world!: World;
  private playerController!: KinematicCharacterController;
  private botController!: KinematicCharacterController;
  private player!: PlayerState;
  private level!: RuntimeLevelV1;
  private bots: BotState[] = [];
  private colliderEntity = new Map<number, number>();
  private staticColliderIds = new Map<number, string>();
  private staticColliderPrimitives = new Map<number, CollisionPrimitiveV2>();
  private staticBodiesByPrimitiveId = new Map<string, RigidBody>();
  private tick = 0;
  private elapsedSeconds = 0;
  private nextEntityId = 1;
  private nextEventId = 1;
  private checkpoint!: CheckpointState;
  private completedEncounters = new Set<string>();
  private activeEncounters = new Set<string>();
  /** Wave currently live in each active encounter. Absent means the room has not begun. */
  private liveWaves = new Map<string, number>();
  private completed = false;
  /** Run-level, so it deliberately survives checkpoint restores. */
  private deaths = 0;
  /** Run-level like `deaths`: the peak is a statistic of the attempt, not of a checkpoint. */
  private comboPeak = 0;
  private splits: RunSplit[] = [];
  private openGateIds: readonly string[] = [];
  private readonly navigation = new NavigationService();
  private random = new SeededRandom(1);
  private settings: SaveDataV1['settings'];
  private loadout: readonly WeaponBuild[];
  private readonly modifier: RunModifier | null;
  /**
   * The blade carried into this run. Every swing number and every chain rule comes from
   * here rather than from a constant, which is what makes the bench a real choice.
   */
  private readonly blade: BladeStyleDefinition;

  constructor(
    settings?: Partial<SaveDataV1['settings']>,
    loadout?: readonly WeaponBuild[],
    modifier: RunModifier | null = null,
    blade?: BladeStyleId,
  ) {
    this.loadout = loadout?.length ? loadout.slice(0, 2) : defaultArmory();
    this.modifier = modifier;
    this.blade = bladeStyle(blade);
    this.settings = {
      sensitivity: 0.002,
      fov: 92,
      cameraRoll: 0.65,
      headBob: 0.35,
      shake: 0.5,
      renderScale: 1,
      debug: false,
      reducedMotion: false,
      ...settings,
    };
  }

  updateSettings(settings: SaveDataV1['settings']): void {
    this.settings = { ...settings };
  }

  async loadLevel(level: RuntimeLevelV1): Promise<void> {
    await initializeRapier();
    this.disposeWorld();
    this.level = structuredClone(level);
    this.random = new SeededRandom(hashSeed(`${level.id}:${level.schemaVersion}`));
    await this.navigation.load(level.navMeshData);
    this.world = new RAPIER.World({ x: 0, y: -movementProfile.gravity, z: 0 });
    this.world.timestep = 1 / 60;
    this.playerController = this.world.createCharacterController(0.02);
    this.botController = this.world.createCharacterController(0.03);
    this.configureCharacterController();
    this.colliderEntity.clear();
    this.staticColliderIds.clear();
    this.staticColliderPrimitives.clear();
    this.staticBodiesByPrimitiveId.clear();
    this.bots = [];
    this.completedEncounters.clear();
    this.activeEncounters.clear();
    this.liveWaves.clear();
    this.completed = false;
    this.deaths = 0;
    this.comboPeak = 0;
    this.splits = [];
    this.tick = 0;
    this.elapsedSeconds = 0;
    this.nextEntityId = 1;
    this.nextEventId = 1;

    for (const primitive of level.primitives) {
      if (primitive.collision) this.createStaticPrimitive(primitive);
    }

    const spawn = level.spawns.find((candidate) => candidate.kind === 'player');
    if (!spawn) throw new Error('Runtime level is missing its player spawn.');
    const playerBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...spawn.position),
    );
    const playerCollider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(playerCapsule.standingHalfHeight, PLAYER_CAPSULE_RADIUS).setCollisionGroups(0x0002_ffff),
      playerBody,
    );
    this.player = {
      id: this.nextEntityId++,
      body: playerBody,
      collider: playerCollider,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: spawn.rotationY,
      pitch: 0,
      health: PLAYER_MAX_HEALTH,
      weapons: this.loadout.map(createWeaponSlot),
      activeSlot: 0,
      weaponReadyTimer: 0,
      locomotion: 'airborne',
      action: 'neutral',
      dashTimer: 0,
      dashElapsed: 0,
      dashWasGrounded: false,
      jumpTapTimer: 0,
      slideTimer: 0,
      vaultTimer: 0,
      coyoteTimer: 0,
      jumpBuffer: 0,
      fireCooldown: 0,
      reloadTimer: 0,
      meleeTimer: 0,
      meleeDuration: this.blade.light.seconds,
      invulnerableTimer: 0,
      dodgeCooldown: 0,
      score: 0,
      ads: false,
      grounded: false,
      grappleAnchor: null,
      grappleColliderHandle: null,
      grappleRopeLength: 0,
      grapplePullTimer: 0,
      grapplePullBoost: 0,
      grappleStallTimer: 0,
      grappleCooldown: 0,
      lockedTargetId: null,
      wallJumpReady: false,
      dryFireReported: false,
      inHand: 'blade',
      comboLinks: 0,
      comboTimer: 0,
      comboKinds: [],
      recoilPitch: 0,
      recoilYaw: 0,
      recoilHold: 0,
      bloom: 0,
      stance: 0,
      airCharge: 1,
      lastRechargeSurface: null,
    };
    this.colliderEntity.set(playerCollider.handle, this.player.id);

    for (const botSpawn of level.spawns.filter((candidate) => candidate.kind !== 'player')) {
      const profile = this.scaledProfile(botProfiles[botProfileKind(botSpawn.kind)]);
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...botSpawn.position),
      );
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.capsule(botCapsule.halfHeight, botCapsule.radius).setCollisionGroups(0x0004_ffff),
        body,
      );
      const bot: BotState = {
        id: this.nextEntityId++,
        spawnId: botSpawn.id,
        profile,
        body,
        collider,
        health: profile.health,
        fireCooldown: 0.4 + this.random.next() * 0.4,
        decisionCooldown: 0,
        strafe: this.random.next() > 0.5 ? 1 : -1,
        alive: true,
        spawnPosition: botSpawn.position,
        waypoint: null,
        encounterId: botSpawn.encounterId,
        wave: botSpawn.wave ?? 0,
        // Only the first wave of a room is ever eligible; the rest wait for the wave
        // before them to be cleared.
        active: !botSpawn.encounterId,
        velocityY: 0,
        velocity: { x: 0, y: 0, z: 0 },
        grounded: false,
        facingYaw: botSpawn.rotationY,
        windupTimer: 0,
        windupSpread: 0,
      };
      body.setEnabled(bot.active);
      this.bots.push(bot);
      this.colliderEntity.set(collider.handle, bot.id);
    }

    this.syncEncounterGates();
    // Colliders only enter the query pipeline on a step, so the spawn probes below
    // need one first or every raycast misses.
    this.world.step();
    this.snapPlayerToGroundAtSpawn();
    for (const bot of this.bots) this.groundBotSpawn(bot);
    this.checkpoint = this.captureCheckpoint();
  }

  step(input: InputFrame, dt: number): SimulationOutput {
    if (!this.player || this.completed) return { snapshot: this.snapshot(), events: [] };
    this.tick = input.tick;
    // Being dead is a state the player leaves deliberately, not a teleport that
    // happens to them. The clock is frozen here so sitting on the death panel is
    // free; the cost of dying was already charged when it happened.
    if (this.player.locomotion === 'dead') {
      const downed: GameEvent[] = [];
      if (input.pressed & (Action.Jump | Action.Attack)) this.respawn(downed);
      return { snapshot: this.snapshot(), events: downed };
    }
    this.elapsedSeconds += dt;
    this.world.timestep = dt;
    const events: GameEvent[] = [];

    this.updateLook(input, dt);
    this.updateTimers(dt, events);
    this.updateMovement(input, dt, events);
    this.updateEncounterActivation();
    this.updateWaves(events);
    this.updateBots(dt, events);
    this.world.step();
    this.updateCombat(input, dt, events);
    this.updateInHand(dt);
    this.updateObjectives(events);

    // The early return above already guarantees the player was alive this tick, and
    // nothing between here and there sets the dead state.
    if (this.player.health <= 0) {
      this.player.locomotion = 'dead';
      this.player.health = 0;
      this.deaths += 1;
      // Charged once, up front, so it cannot be waited out and cannot compound with
      // a checkpoint restore the way a score penalty would.
      this.elapsedSeconds += runScoring.deathTimePenaltySeconds;
      if (this.player.grappleAnchor) this.releaseGrapple(events, false);
      events.push(this.event('death', this.positionOf(this.player.body), this.player.id, this.deaths));
      // Reported after the death so the two read in the order they happened.
      this.player.comboTimer = 0;
      this.breakCombo(events);
    }

    return { snapshot: this.snapshot(), events };
  }

  /** Sends the player back to their checkpoint at full strength. */
  private respawn(events: GameEvent[]): void {
    this.restoreCheckpoint();
    this.player.health = PLAYER_MAX_HEALTH;
    events.push(this.event('respawn', this.positionOf(this.player.body), this.player.id, this.deaths));
  }

  captureCheckpoint(): CheckpointState {
    const position = this.player ? this.positionOf(this.player.body) : [0, 1, 0] as const;
    return {
      position,
      health: this.player?.health ?? 100,
      ammo: this.player?.weapons.map((slot) => slot.ammo) ?? [],
      reserveAmmo: this.player?.weapons.map((slot) => slot.reserveAmmo) ?? [],
      activeSlot: this.player?.activeSlot ?? 0,
      inHand: this.player?.inHand ?? 'blade',
      score: this.player?.score ?? 0,
      completedEncounterIds: [...this.completedEncounters],
      defeatedBotIds: this.bots.filter((bot) => !bot.alive).map((bot) => bot.id),
    };
  }

  restoreCheckpoint(): void {
    if (!this.player || !this.checkpoint) return;
    const [x, y, z] = this.checkpoint.position;
    this.player.body.setTranslation({ x, y, z }, true);
    this.player.body.setNextKinematicTranslation({ x, y, z });
    this.player.velocity = { x: 0, y: 0, z: 0 };
    this.player.health = Math.max(50, this.checkpoint.health);
    this.player.weapons.forEach((slot, index) => {
      slot.ammo = this.checkpoint.ammo[index] ?? slot.stats.magazineSize;
      slot.reserveAmmo = this.checkpoint.reserveAmmo[index] ?? slot.stats.reserveAmmo;
    });
    this.player.activeSlot = this.checkpoint.activeSlot;
    this.player.inHand = this.checkpoint.inHand;
    this.player.weaponReadyTimer = 0;
    this.player.score = this.checkpoint.score;
    this.player.locomotion = 'airborne';
    this.player.action = 'neutral';
    this.player.airCharge = 1;
    this.player.lastRechargeSurface = null;
    this.player.grounded = false;
    this.player.dashTimer = 0;
    this.player.dashElapsed = 0;
    this.player.dashWasGrounded = false;
    this.player.invulnerableTimer = 0;
    this.player.dodgeCooldown = 0;
    this.player.jumpTapTimer = 0;
    this.player.slideTimer = 0;
    this.player.vaultTimer = 0;
    this.player.coyoteTimer = 0;
    this.player.jumpBuffer = 0;
    this.player.fireCooldown = 0;
    this.player.reloadTimer = 0;
    this.player.meleeTimer = 0;
    this.player.ads = false;
    this.player.grappleAnchor = null;
    this.player.grappleColliderHandle = null;
    this.player.grappleRopeLength = 0;
    this.player.grapplePullTimer = 0;
    this.player.grapplePullBoost = 0;
    this.player.grappleStallTimer = 0;
    this.player.grappleCooldown = 0;
    this.player.lockedTargetId = null;
    this.player.wallJumpReady = false;
    this.player.dryFireReported = false;
    this.player.comboLinks = 0;
    this.player.comboTimer = 0;
    this.player.comboKinds = [];
    this.player.recoilPitch = 0;
    this.player.recoilYaw = 0;
    this.player.recoilHold = 0;
    this.player.bloom = 0;
    this.player.stance = 0;
    this.applyStance();
    const defeated = new Set(this.checkpoint.defeatedBotIds);
    this.completedEncounters = new Set(this.checkpoint.completedEncounterIds);
    this.activeEncounters = new Set(this.checkpoint.completedEncounterIds);
    // Rooms roll back to unstarted, so the proximity check re-opens them at wave one.
    // Hostiles already killed stay dead, so a room whose first wave was cleared simply
    // advances again on the next tick rather than resurrecting it.
    this.liveWaves.clear();
    // A restore can only ever roll encounters back, so splits follow it rather than
    // reporting a checkpoint the player no longer holds.
    this.splits = this.splits.filter((split) => this.completedEncounters.has(split.encounterId));
    for (const bot of this.bots) {
      const shouldBeAlive = !defeated.has(bot.id);
      bot.active = !bot.encounterId || this.activeEncounters.has(bot.encounterId);
      bot.alive = shouldBeAlive;
      bot.health = shouldBeAlive ? Math.min(bot.health, bot.profile.health) : 0;
      bot.body.setEnabled(shouldBeAlive && bot.active);
      if (shouldBeAlive && bot.active) {
        const [botX, botY, botZ] = bot.spawnPosition;
        bot.body.setTranslation({ x: botX, y: botY, z: botZ }, true);
        bot.body.setNextKinematicTranslation({ x: botX, y: botY, z: botZ });
        bot.fireCooldown = 0.5;
        bot.windupTimer = 0;
        bot.windupSpread = 0;
        bot.velocityY = 0;
        bot.velocity = { x: 0, y: 0, z: 0 };
        bot.grounded = false;
      }
    }
    this.syncEncounterGates();
  }

  suspend(): GameEvent[] {
    if (!this.player?.grappleAnchor) return [];
    const events: GameEvent[] = [];
    this.releaseGrapple(events, false);
    return events;
  }

  dispose(): void {
    this.disposeWorld();
    this.navigation.dispose();
  }

  /**
   * Applies the day's modifier to a bot profile. Scalings are multiplicative so an
   * authored profile stays the source of truth and a modifier can only bend it.
   */
  private scaledProfile(profile: BotProfile): BotProfile {
    const enemy = this.modifier?.enemy;
    if (!enemy) return profile;
    // Spread first, so a scaling can only bend what it names; the shield arc, turn
    // rate and firing arc are behaviour, not numbers a daily is allowed to retune.
    return {
      ...profile,
      health: profile.health * (enemy.health ?? 1),
      moveSpeed: profile.moveSpeed * (enemy.moveSpeed ?? 1),
      preferredRange: profile.preferredRange * (enemy.preferredRange ?? 1),
      fireInterval: profile.fireInterval * (enemy.fireInterval ?? 1),
      damage: profile.damage * (enemy.damage ?? 1),
      windupSeconds: profile.windupSeconds * (enemy.windupSeconds ?? 1),
      baseSpread: profile.baseSpread * (enemy.baseSpread ?? 1),
    };
  }

  /** Score multiplier from the day's modifier, given what the player is carrying. */
  private modifierMultiplier(): number {
    if (!this.modifier) return 1;
    const chassis = this.player?.weapons[this.player.activeSlot]?.build.chassisId;
    const carried = chassis ? chassisMultiplier(this.modifier, chassis) : 1;
    return carried + (this.modifier.runBonus ?? 0);
  }

  private configureCharacterController(): void {
    this.playerController.enableAutostep(0.4, 0.25, false);
    this.playerController.enableSnapToGround(0.25);
    this.playerController.setMaxSlopeClimbAngle(Math.PI * 0.28);
    this.playerController.setMinSlopeSlideAngle(Math.PI * 0.2);
    this.botController.enableAutostep(0.4, 0.25, false);
    this.botController.enableSnapToGround(0.3);
    this.botController.setMaxSlopeClimbAngle(Math.PI * 0.28);
  }

  private createStaticPrimitive(primitive: CollisionPrimitiveV2): void {
    const [x, y, z] = primitive.transform.position;
    const [sx, sy, sz] = primitive.transform.scale;
    const [rx, ry, rz] = primitive.transform.rotation;
    const rotation = eulerQuaternion(rx, ry, rz);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(rotation),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setCollisionGroups(0x0001_ffff),
      body,
    );
    this.staticColliderIds.set(collider.handle, primitive.id);
    this.staticColliderPrimitives.set(collider.handle, primitive);
    this.staticBodiesByPrimitiveId.set(primitive.id, body);
  }

  private updateLook(input: InputFrame, dt: number): void {
    const player = this.player;
    // Resolved against the aim the player came into the tick with, so the damping
    // below applies to the same input the target was judged against.
    const target = this.resolveAimTarget(input);
    const sensitivity = this.settings.sensitivity * this.assistSlowdown(target);
    player.yaw -= input.look[0] * sensitivity;
    player.pitch = clamp(player.pitch - input.look[1] * sensitivity, -1.48, 1.48);
    this.applyRecoilRecovery(dt);
    this.applyAimMagnetism(target, dt);
    // The target was resolved against the incoming aim, so re-check it against where
    // the view actually ended up. Without this the lock the HUD reports lags a tick
    // behind, and a player who whips off a target still sees it held.
    this.validateLock();
  }

  private validateLock(): void {
    const player = this.player;
    const target = this.bots.find((bot) => bot.id === player.lockedTargetId);
    if (!target) return;
    const origin = this.cameraPosition();
    const forward = directionFromLook(player.yaw, player.pitch);
    const position = target.body.translation();
    const dx = position.x - origin.x;
    const dy = position.y + aimAssist.aimHeight - origin.y;
    const dz = position.z - origin.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.001) return;
    const dot = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
    if (distance > aimAssist.range || dot < aimAssist.holdCosine) player.lockedTargetId = null;
  }

  /** The bot ADS is tracking, or null. Hip fire is always fully manual. */
  private resolveAimTarget(input: InputFrame): BotState | null {
    const player = this.player;
    if (!(input.held & Action.Ads) || player.locomotion === 'dead') {
      player.lockedTargetId = null;
      return null;
    }
    const origin = this.cameraPosition();
    const forward = directionFromLook(player.yaw, player.pitch);
    const held = this.bots.find((bot) => bot.id === player.lockedTargetId);
    const target = this.aimAssistTarget(origin, forward, held);
    player.lockedTargetId = target?.id ?? null;
    return target;
  }

  /** 0 at the edge of the acquisition cone, 1 with the target dead centre. */
  private aimCentredness(target: BotState): number {
    const origin = this.cameraPosition();
    const forward = directionFromLook(this.player.yaw, this.player.pitch);
    const position = target.body.translation();
    const dx = position.x - origin.x;
    const dy = position.y + aimAssist.aimHeight - origin.y;
    const dz = position.z - origin.z;
    const distance = Math.hypot(dx, dy, dz) || 1;
    const dot = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
    return clamp((dot - aimAssist.acquireCosine) / (1 - aimAssist.acquireCosine), 0, 1);
  }

  /**
   * Damping on the player's own look, strongest with the target centred. This is the
   * assist: it makes a target easier to hold without moving the crosshair for anyone.
   */
  private assistSlowdown(target: BotState | null): number {
    if (!target) return 1;
    return 1 - (1 - aimAssist.slowdownScale) * this.aimCentredness(target);
  }

  /**
   * A bounded nudge toward centre mass. Capped as a *rate* rather than as a fraction
   * of the remaining error, so it can settle a shot the player has already lined up
   * and can never travel far enough to acquire one for them.
   */
  private applyAimMagnetism(target: BotState | null, dt: number): void {
    if (!target) return;
    const player = this.player;
    const origin = this.cameraPosition();
    const position = target.body.translation();
    const dx = position.x - origin.x;
    const dy = position.y + aimAssist.aimHeight - origin.y;
    const dz = position.z - origin.z;
    const step = aimAssist.maxTurnRate * dt * this.aimCentredness(target);
    if (step <= 0) return;
    player.yaw += clamp(wrapAngle(Math.atan2(-dx, -dz) - player.yaw), -step, step);
    const pitchError = Math.atan2(dy, Math.hypot(dx, dz)) - player.pitch;
    player.pitch = clamp(player.pitch + clamp(pitchError, -step, step), -1.48, 1.48);
  }

  /**
   * Hands back only what recoil added, so a correction the player made while fighting
   * the climb survives instead of being undone by the recovery.
   */
  private applyRecoilRecovery(dt: number): void {
    const player = this.player;
    if (player.recoilHold > 0 || (player.recoilPitch === 0 && player.recoilYaw === 0)) return;
    const rate = player.weapons[player.activeSlot].stats.recoilRecovery * dt;
    const nextPitch = approach(player.recoilPitch, 0, rate);
    const nextYaw = approach(player.recoilYaw, 0, rate);
    player.pitch = clamp(player.pitch - (player.recoilPitch - nextPitch), -1.48, 1.48);
    player.yaw -= player.recoilYaw - nextYaw;
    player.recoilPitch = nextPitch;
    player.recoilYaw = nextYaw;
  }

  private aimAssistTarget(origin: RAPIER.Vector, forward: RAPIER.Vector, held: BotState | undefined): BotState | null {
    const visible = (bot: BotState, cosine: number): boolean => {
      if (!bot.alive || !bot.active) return false;
      const position = bot.body.translation();
      const dx = position.x - origin.x;
      const dy = position.y + aimAssist.aimHeight - origin.y;
      const dz = position.z - origin.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > aimAssist.range || distance < 0.001) return false;
      const dot = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
      return dot >= cosine && this.hasClearShot(origin, { x: dx / distance, y: dy / distance, z: dz / distance }, distance);
    };

    if (held && visible(held, aimAssist.holdCosine)) return held;

    let best: BotState | null = null;
    let bestDot = aimAssist.acquireCosine;
    for (const bot of this.bots) {
      if (!visible(bot, aimAssist.acquireCosine)) continue;
      const position = bot.body.translation();
      const dx = position.x - origin.x;
      const dy = position.y + aimAssist.aimHeight - origin.y;
      const dz = position.z - origin.z;
      const distance = Math.hypot(dx, dy, dz);
      const dot = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
      if (dot >= bestDot) {
        best = bot;
        bestDot = dot;
      }
    }
    return best;
  }

  /** True when no static geometry sits between the camera and the target. */
  private hasClearShot(origin: RAPIER.Vector, direction: RAPIER.Vector, distance: number): boolean {
    const hit = this.world.castRay(
      new RAPIER.Ray(origin, direction), distance, true, undefined, undefined,
      this.player.collider, this.player.body, (collider) => this.staticColliderIds.has(collider.handle),
    );
    return !hit;
  }

  private updateTimers(dt: number, events: GameEvent[]): void {
    const player = this.player;
    const reloadWasActive = player.action === 'reloading' && player.reloadTimer > 0;
    if (player.dashTimer > 0) player.dashElapsed += dt;
    player.dashTimer = Math.max(0, player.dashTimer - dt);
    if (player.dashTimer === 0) player.dashWasGrounded = false;
    player.jumpTapTimer = Math.max(0, player.jumpTapTimer - dt);
    player.slideTimer = Math.max(0, player.slideTimer - dt);
    player.vaultTimer = Math.max(0, player.vaultTimer - dt);
    player.coyoteTimer = Math.max(0, player.coyoteTimer - dt);
    player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);
    player.fireCooldown = Math.max(0, player.fireCooldown - dt);
    player.reloadTimer = Math.max(0, player.reloadTimer - dt);
    player.meleeTimer = Math.max(0, player.meleeTimer - dt);
    // The cooldown is measured in *running* time: it only starts counting down once
    // the frames have expired, so holding a dash cannot pay off its own gate.
    player.invulnerableTimer = Math.max(0, player.invulnerableTimer - dt);
    if (player.invulnerableTimer === 0) player.dodgeCooldown = Math.max(0, player.dodgeCooldown - dt);
    player.grappleCooldown = Math.max(0, player.grappleCooldown - dt);
    player.grapplePullTimer = Math.max(0, player.grapplePullTimer - dt);
    player.weaponReadyTimer = Math.max(0, player.weaponReadyTimer - dt);
    player.recoilHold = Math.max(0, player.recoilHold - dt);
    // Shed only once firing stops, for the same reason recoil recovery is held: any
    // rate fast enough to settle between bursts also cancels the accumulation inside
    // one, and at 720 rounds a minute the bloom never formed at all.
    if (player.recoilHold === 0) {
      player.bloom = Math.max(0, player.bloom - player.weapons[player.activeSlot].stats.bloomRecovery * dt);
    }

    if (player.action === 'reloading' && player.reloadTimer === 0) {
      const slot = player.weapons[player.activeSlot];
      const transferred = Math.min(slot.stats.magazineSize - slot.ammo, slot.reserveAmmo);
      slot.ammo += transferred;
      slot.reserveAmmo -= transferred;
      player.action = 'neutral';
      if (reloadWasActive) {
        events.push(this.event('reloadComplete', this.cameraPosition(), undefined, undefined, {
          sourceEntityId: player.id,
        }));
      }
    }
    if (player.action === 'melee' && player.meleeTimer === 0) player.action = 'neutral';

    if (player.comboLinks > 0) {
      player.comboTimer = Math.max(0, player.comboTimer - dt);
      if (player.comboTimer === 0) this.breakCombo(events);
    }
  }

  private updateMovement(input: InputFrame, dt: number, events: GameEvent[]): void {
    const player = this.player;
    const position = player.body.translation();
    const groundedBefore = player.grounded;
    const forward = forwardFromYaw(player.yaw);
    const right = { x: Math.cos(player.yaw), z: -Math.sin(player.yaw) };
    const inputX = Number(Boolean(input.held & Action.Right)) - Number(Boolean(input.held & Action.Left));
    const inputZ = Number(Boolean(input.held & Action.Forward)) - Number(Boolean(input.held & Action.Back));
    const inputLength = Math.hypot(inputX, inputZ) || 1;
    const moveX = (right.x * inputX + forward.x * inputZ) / inputLength;
    const moveZ = (right.z * inputX + forward.z * inputZ) / inputLength;
    const hasMove = inputX !== 0 || inputZ !== 0;

    this.updateGrappleInput(input, events);

    const wall = this.findWall(position, player.yaw);
    // A wall jump is worth more than a dash, so an airborne tap against a
    // wall-run surface is never eaten by the double-tap window.
    const wallJumpAvailable = Boolean(wall) && !groundedBefore && player.coyoteTimer <= 0 && !player.grappleAnchor;
    player.wallJumpReady = wallJumpAvailable;

    // Jump is also the dash key. A second press inside the double-tap window is
    // consumed as a dash so spamming the key alternates jump, dash, jump.
    const jumpPressed = Boolean(input.pressed & Action.Jump);
    const doubleTapped = jumpPressed && player.jumpTapTimer > 0 && !wallJumpAvailable;
    if (jumpPressed) player.jumpTapTimer = doubleTapped ? 0 : movementProfile.dashDoubleTapSeconds;
    const dashPressed = Boolean(input.pressed & Action.Dash) || doubleTapped;
    // A jump cannot fight the rail, so it is suppressed while hooked. Double-tapping
    // still dashes, which stays available as a deliberate escape.
    const jumpUsable = jumpPressed && !doubleTapped && !player.grappleAnchor;
    // The pull has its own key, so jumping and dashing stay completely normal while
    // tethered and nothing has to arbitrate between them.
    const pullRequested = Boolean(input.pressed & Action.GrapplePull) && Boolean(player.grappleAnchor);

    if (jumpUsable) player.jumpBuffer = movementProfile.jumpBufferSeconds;
    if (groundedBefore) player.coyoteTimer = movementProfile.coyoteSeconds;

    const rechargeWall = wall ?? this.findRechargeWall(position, player.yaw);
    if (!groundedBefore && rechargeWall) {
      const previousSurface = player.lastRechargeSurface;
      const reset = resetFromWall(player, `wall:${rechargeWall.collider.handle}`);
      player.airCharge = reset.airCharge;
      player.lastRechargeSurface = reset.lastRechargeSurface;
      if (wall && hasMove && player.dashTimer === 0 && player.vaultTimer === 0) {
        player.locomotion = wall.side < 0 ? 'wall-running-left' : 'wall-running-right';
        if (player.lastRechargeSurface !== previousSurface) this.addComboLink(events, 'wall-run');
      }
    }

    if (dashPressed && (groundedBefore || player.airCharge > 0) && player.dashTimer === 0) {
      if (!groundedBefore) {
        const consumed = consumeAirCharge(player);
        player.airCharge = consumed.airCharge;
        // Only the air dash links; nothing limits how often a ground dash can be
        // pressed on a flat floor.
        this.addComboLink(events, 'dash');
      }
      const dashX = hasMove ? moveX : forward.x;
      const dashZ = hasMove ? moveZ : forward.z;
      // Dashing is the way out of a pull: drop the line, then dash cleanly.
      if (player.grappleAnchor) this.releaseGrapple(events, false);
      player.velocity.x = dashX * movementProfile.dashSpeed;
      player.velocity.z = dashZ * movementProfile.dashSpeed;
      player.velocity.y = Math.max(player.velocity.y, groundedBefore ? 0.5 : 1.5);
      player.dashTimer = movementProfile.dashSeconds;
      player.dashElapsed = 0;
      player.dashWasGrounded = groundedBefore;
      player.locomotion = 'dashing';
      // The frames are gated, the dash is not. A ground dash has no cooldown of its
      // own, so tying invulnerability to the dash alone would be permanent
      // invulnerability on a flat floor; rationing only the defence leaves every
      // traversal property of the kit exactly where it was.
      if (player.dodgeCooldown === 0) {
        player.invulnerableTimer = dodge.invulnerableSeconds;
        player.dodgeCooldown = dodge.cooldownSeconds;
      }
    }

    const waitingForDashCancel = player.dashWasGrounded && player.dashTimer > 0 && player.dashElapsed < 2 / 60;
    if (player.jumpBuffer > 0 && !waitingForDashCancel) {
      const cancellingGroundDash = player.dashWasGrounded && player.dashTimer > 0;
      if (groundedBefore || player.coyoteTimer > 0) {
        player.velocity.y = movementProfile.jumpSpeed;
        player.jumpBuffer = 0;
        player.coyoteTimer = 0;
        player.locomotion = 'airborne';
      } else if (wall) {
        player.velocity.x = wall.normal.x * movementProfile.wallJumpHorizontal + forward.x * 3;
        player.velocity.z = wall.normal.z * movementProfile.wallJumpHorizontal + forward.z * 3;
        player.velocity.y = movementProfile.wallJumpVertical;
        player.jumpBuffer = 0;
        player.locomotion = 'airborne';
        this.addComboLink(events, 'wall-jump');
      }
      if (cancellingGroundDash && player.jumpBuffer === 0) {
        player.dashTimer = 0;
        player.dashElapsed = 0;
        player.dashWasGrounded = false;
      }
    }

    const crouchHeld = Boolean(input.held & Action.Crouch);
    if ((input.pressed & Action.Crouch) && groundedBefore && Math.hypot(player.velocity.x, player.velocity.z) > 5) {
      player.slideTimer = movementProfile.slideSeconds;
      player.velocity.x *= movementProfile.slideBoost;
      player.velocity.z *= movementProfile.slideBoost;
      player.locomotion = 'sliding';
    }
    this.updateStance(crouchHeld, dt);

    if (jumpUsable && groundedBefore && !waitingForDashCancel && this.canVault(position, forward)) {
      player.velocity.x = forward.x * 9;
      player.velocity.z = forward.z * 9;
      player.velocity.y = 7.5;
      player.vaultTimer = 0.34;
      player.locomotion = 'vaulting';
      this.addComboLink(events, 'vault');
    }

    if (player.slideTimer > 0 && groundedBefore) this.applySlideSlope(position, dt);

    const lockedVelocity = player.dashTimer > 0 || player.vaultTimer > 0 || Boolean(player.grappleAnchor);
    if (!lockedVelocity) {
      const crouched = player.stance > 0.5 && player.slideTimer <= 0;
      const targetSpeed = crouched
        ? movementProfile.crouchSpeed
        : input.held & Action.Sprint ? movementProfile.sprintSpeed : movementProfile.walkSpeed;
      const acceleration = groundedBefore ? movementProfile.groundAcceleration : movementProfile.airAcceleration;
      // Standard ground movement is momentum-free: velocity snaps to the input
      // instead of ramping. Slides keep their boost, a launching frame keeps
      // whatever the dash or jump cancel just produced, and an attached rope owns
      // its own velocity, so none of the air tech is flattened by this.
      const snapToInput = groundedBefore && player.slideTimer <= 0 && player.velocity.y <= 0 && !player.grappleAnchor;
      if (hasMove) {
        player.velocity.x = snapToInput ? moveX * targetSpeed : approach(player.velocity.x, moveX * targetSpeed, acceleration * dt);
        player.velocity.z = snapToInput ? moveZ * targetSpeed : approach(player.velocity.z, moveZ * targetSpeed, acceleration * dt);
      } else if (snapToInput) {
        player.velocity.x = 0;
        player.velocity.z = 0;
      } else if (groundedBefore) {
        player.velocity.x = approach(player.velocity.x, 0, movementProfile.groundFriction * dt);
        player.velocity.z = approach(player.velocity.z, 0, movementProfile.groundFriction * dt);
      }

      const wallRunning = player.locomotion === 'wall-running-left' || player.locomotion === 'wall-running-right';
      player.velocity.y -= (wallRunning ? movementProfile.wallRunGravity : movementProfile.gravity) * dt;
      if (wallRunning) player.velocity.y = Math.max(player.velocity.y, -2.5);
    }

    this.applyGrapplePull(pullRequested, dt, events);

    const desired = { x: player.velocity.x * dt, y: player.velocity.y * dt, z: player.velocity.z * dt };
    this.playerController.computeColliderMovement(player.collider, desired, undefined, undefined, (collider) => collider.handle !== player.collider.handle);
    const movement = this.playerController.computedMovement();
    player.body.setNextKinematicTranslation({ x: position.x + movement.x, y: position.y + movement.y, z: position.z + movement.z });
    const groundedAfter = this.playerController.computedGrounded();
    player.grounded = groundedAfter;

    if (groundedAfter) {
      if (player.velocity.y < 0) player.velocity.y = 0;
      const reset = resetFromGround(player);
      player.airCharge = reset.airCharge;
      player.lastRechargeSurface = reset.lastRechargeSurface;
      if (player.slideTimer > 0) player.locomotion = 'sliding';
      else if (player.dashTimer <= 0 && player.vaultTimer <= 0) {
        player.locomotion = player.grappleAnchor ? 'grappling' : player.stance > 0.5 ? 'crouching' : 'grounded';
      }
    } else if (player.dashTimer <= 0 && player.vaultTimer <= 0 && !wall) {
      player.locomotion = player.grappleAnchor ? 'grappling' : 'airborne';
    }

    // Test the position the controller actually committed to, not the one this
    // tick started from, so falling out of the level is caught on the same tick.
    if (position.y + movement.y < VOID_Y) player.health = 0;
  }

  /**
   * Crouching shrinks the collider for real. Standing back up is refused while there is
   * no headroom, so a player who slid under geometry cannot pop through it.
   */
  private updateStance(crouchHeld: boolean, dt: number): void {
    const player = this.player;
    const wantsLow = crouchHeld || player.slideTimer > 0;
    const target = wantsLow ? 1 : this.hasStandingHeadroom() ? 0 : 1;
    const previous = player.stance;
    player.stance = approach(player.stance, target, playerCapsule.stanceRate * dt);
    if (player.stance !== previous) this.applyStance();
  }

  private applyStance(): void {
    const player = this.player;
    const halfHeight = playerCapsule.standingHalfHeight
      + (playerCapsule.crouchedHalfHeight - playerCapsule.standingHalfHeight) * player.stance;
    player.collider.setHalfHeight(halfHeight);
  }

  private hasStandingHeadroom(): boolean {
    const player = this.player;
    if (player.stance <= 0) return true;
    const position = player.body.translation();
    const hit = this.world.castRay(
      new RAPIER.Ray({ x: position.x, y: position.y, z: position.z }, UP),
      STAND_CLEARANCE + playerCapsule.crouchedHalfHeight + PLAYER_CAPSULE_RADIUS,
      true, undefined, undefined, player.collider, player.body,
      (collider) => this.staticColliderIds.has(collider.handle),
    );
    return hit === null;
  }

  /**
   * A slide gains speed downhill. The ground normal comes from a probe rather than the
   * controller, which reports whether it is grounded but not what it is standing on.
   */
  private applySlideSlope(position: RAPIER.Vector, dt: number): void {
    const player = this.player;
    const hit = this.world.castRayAndGetNormal(
      new RAPIER.Ray(position, DOWN),
      playerCapsule.standingHalfHeight + PLAYER_CAPSULE_RADIUS + 0.35,
      true, undefined, undefined, player.collider, player.body,
      (collider) => this.staticColliderIds.has(collider.handle),
    );
    if (!hit) return;
    const normal = hit.normal;
    // Downhill is gravity projected onto the surface. A flat floor leaves nothing.
    const slope = Math.hypot(normal.x, normal.z);
    if (slope < 0.02) return;
    const gain = movementProfile.slideSlopeAcceleration * slope * dt;
    player.velocity.x += (normal.x / slope) * gain;
    player.velocity.z += (normal.z / slope) * gain;
  }

  private updateGrappleInput(input: InputFrame, events: GameEvent[]): void {
    const player = this.player;
    if (input.released & Action.Grapple) {
      this.releaseGrapple(events, true);
      return;
    }
    if (!(input.pressed & Action.Grapple)) return;
    if (player.grappleAnchor || player.grappleCooldown > 0) {
      events.push(this.event('grappleFail', this.cameraPosition()));
      return;
    }
    const origin = this.cameraPosition();
    const direction = directionFromLook(player.yaw, player.pitch);
    const hit = this.world.castRayAndGetNormal(
      new RAPIER.Ray(origin, direction),
      movementProfile.grappleRange,
      true,
      undefined,
      undefined,
      player.collider,
      player.body,
      (collider) => this.traversalForCollider(collider.handle)?.grapple === true,
    );
    if (!hit) {
      const miss: Vec3 = [origin.x + direction.x * movementProfile.grappleRange, origin.y + direction.y * movementProfile.grappleRange, origin.z + direction.z * movementProfile.grappleRange];
      events.push(this.event('grappleFail', miss));
      return;
    }
    const anchor: Vec3 = [origin.x + direction.x * hit.timeOfImpact, origin.y + direction.y * hit.timeOfImpact, origin.z + direction.z * hit.timeOfImpact];
    // Anything closer than the minimum would sit inside the arrival radius and
    // release on the tick it attached, silently burning the cooldown and letting
    // the pull press fall through to an ordinary jump.
    if (hit.timeOfImpact < movementProfile.grappleMinimumRange) {
      events.push(this.event('grappleFail', anchor));
      return;
    }
    player.grappleAnchor = anchor;
    player.grappleColliderHandle = hit.collider.handle;
    player.grappleRopeLength = hit.timeOfImpact;
    player.grapplePullTimer = 0;
    player.grapplePullBoost = 0;
    player.grappleStallTimer = 0;
    events.push(this.event('grappleAttach', anchor));
    this.addComboLink(events, 'hook');
  }

  /**
   * Holding the hook travels the straight line to the anchor at a constant speed,
   * so the path is exactly the line that was aimed at. Each pull press adds to that
   * speed for the rest of the tether, letting the player choose how hard to commit.
   * Gravity and movement input stand down for the duration.
   */
  private applyGrapplePull(pullRequested: boolean, dt: number, events: GameEvent[]): void {
    const player = this.player;
    const anchor = player.grappleAnchor;
    if (!anchor) return;
    const position = player.body.translation();
    const camera = this.cameraPosition();
    const toAnchor = { x: anchor[0] - position.x, y: anchor[1] - position.y, z: anchor[2] - position.z };
    const distance = Math.hypot(toAnchor.x, toAnchor.y, toAnchor.z);
    if (!Number.isFinite(distance) || distance > movementProfile.grappleRange || !this.hasGrappleLineOfSight(camera, anchor, player.grappleColliderHandle)) {
      this.releaseGrapple(events, false);
      return;
    }
    if (distance <= movementProfile.grappleArrivalRadius) {
      this.releaseGrapple(events, true);
      return;
    }

    if (pullRequested && player.grapplePullTimer === 0) {
      player.grapplePullTimer = movementProfile.grapplePullCooldown;
      player.grapplePullBoost = Math.min(
        movementProfile.grappleMaxSpeed - movementProfile.grapplePullSpeed,
        player.grapplePullBoost + movementProfile.grapplePullImpulse,
      );
      events.push(this.event('grapplePull', anchor));
      this.addComboLink(events, 'pull');
    }

    // Geometry can wedge the capsule short of the anchor. Rather than hanging
    // there, give up on the pull once progress stalls.
    const previous = player.grappleRopeLength;
    player.grappleStallTimer = previous > 0 && previous - distance < GRAPPLE_PROGRESS_EPSILON
      ? player.grappleStallTimer + dt
      : 0;
    player.grappleRopeLength = distance;
    if (player.grappleStallTimer >= GRAPPLE_STALL_SECONDS) {
      this.releaseGrapple(events, false);
      return;
    }

    // The character controller sweeps its capsule along the whole step, so these
    // speeds do not tunnel; `grappleMaxSpeed` is the only ceiling.
    const speed = Math.min(
      movementProfile.grappleMaxSpeed,
      movementProfile.grapplePullSpeed + player.grapplePullBoost,
    );
    const direction = normalize3(toAnchor);
    player.velocity.x = direction.x * speed;
    player.velocity.y = direction.y * speed;
    player.velocity.z = direction.z * speed;
  }

  /**
   * Where a cast would attach from the current view, and whether it would be accepted.
   * Shares the cast the press itself uses, so the preview cannot disagree with the
   * result. Null when the ray finds nothing hookable inside range.
   */
  private grappleAim(): { point: Vec3; valid: boolean } | null {
    const player = this.player;
    if (!player || player.grappleAnchor || player.locomotion === 'dead') return null;
    const origin = this.cameraPosition();
    const direction = directionFromLook(player.yaw, player.pitch);
    const hit = this.world.castRay(
      new RAPIER.Ray(origin, direction), movementProfile.grappleRange, true, undefined, undefined,
      player.collider, player.body,
      (collider) => this.traversalForCollider(collider.handle)?.grapple === true,
    );
    if (!hit) return null;
    const point: Vec3 = [
      origin.x + direction.x * hit.timeOfImpact,
      origin.y + direction.y * hit.timeOfImpact,
      origin.z + direction.z * hit.timeOfImpact,
    ];
    return {
      point,
      valid: hit.timeOfImpact >= movementProfile.grappleMinimumRange && player.grappleCooldown <= 0,
    };
  }

  private hasGrappleLineOfSight(origin: RAPIER.Vector, anchor: Vec3, colliderHandle: number | null): boolean {
    if (colliderHandle === null) return false;
    const offset = { x: anchor[0] - origin.x, y: anchor[1] - origin.y, z: anchor[2] - origin.z };
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    const hit = this.world.castRay(
      new RAPIER.Ray(origin, normalize3(offset)), distance + 0.08, true, undefined, undefined,
      this.player.collider, this.player.body, (collider) => this.staticColliderIds.has(collider.handle),
    );
    return hit?.collider.handle === colliderHandle;
  }

  private releaseGrapple(events: GameEvent[], boost: boolean): void {
    const player = this.player;
    if (!player.grappleAnchor) return;
    const anchor = player.grappleAnchor;
    if (boost) {
      const speed = Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z) || 1;
      player.velocity.x += (player.velocity.x / speed) * movementProfile.grappleReleaseBoost;
      player.velocity.y += (player.velocity.y / speed) * movementProfile.grappleReleaseBoost;
      player.velocity.z += (player.velocity.z / speed) * movementProfile.grappleReleaseBoost;
    }
    player.grappleAnchor = null;
    player.grappleColliderHandle = null;
    player.grappleRopeLength = 0;
    player.grapplePullTimer = 0;
    player.grapplePullBoost = 0;
    player.grappleStallTimer = 0;
    player.grappleCooldown = movementProfile.grappleCooldown;
    events.push(this.event('grappleRelease', anchor));
  }

  private updateCombat(input: InputFrame, _dt: number, events: GameEvent[]): void {
    const player = this.player;
    // One click per trigger pull, whether the player pulled on an empty weapon or
    // held through the last round.
    if (input.released & Action.Attack) player.dryFireReported = false;
    // Selection first: everything below reads what is in the player's hands, and a
    // weapon drawn on this tick has to be the one this tick acts with.
    this.updateWeaponSwitch(input);
    // Sights belong to a gun. A blade has none, and leaving the zoom live across a swap
    // would hand the player a slowed walk with nothing to aim.
    player.ads = player.inHand === 'gun' && Boolean(input.held & Action.Ads);
    const slot = player.weapons[player.activeSlot];
    const weapon = slot.stats;

    if ((input.pressed & Action.Reload) && player.inHand === 'gun' && player.action !== 'melee' && slot.ammo < weapon.magazineSize && slot.reserveAmmo > 0) {
      this.startReload(events);
    }
    const bladeInHand = player.inHand === 'blade';

    // One trigger, and the selection decides what it does. Held rather than pressed,
    // because the blade is the primary verb and holding the button has to produce a
    // rhythm at the recovery rate instead of one swing per click -- clicking four times
    // a second is not a control scheme.
    //
    // The heavy is pressed rather than held and is checked first: it is the deliberate
    // one, and a player holding both should get the swing they went out of their way to
    // ask for. It is a blade attack, so it needs the blade in hand like every other one.
    if (player.meleeTimer === 0 && bladeInHand) {
      if (input.pressed & Action.Melee) this.swing(events, 'heavy');
      else if (input.held & Action.Attack) this.swing(events, 'light');
    }

    const canFire = player.fireCooldown === 0 && player.weaponReadyTimer === 0
      && player.action !== 'reloading' && player.action !== 'melee';
    if (!bladeInHand && (input.held & Action.Attack) && canFire) {
      if (slot.ammo <= 0) {
        if (slot.reserveAmmo > 0) this.startReload(events);
        else if (!player.dryFireReported) {
          player.dryFireReported = true;
          events.push(this.event('dryFire', this.cameraPosition(), player.id));
        }
        // Without this the empty branch returned past the reset below and left the
        // action reading `firing` for as long as the trigger stayed down.
        if (player.action === 'firing') player.action = 'neutral';
        return;
      }
      player.action = 'firing';
      slot.ammo -= 1;
      player.fireCooldown = 60 / weapon.roundsPerMinute;
      const origin = this.cameraPosition();
      const baseDirection = directionFromLook(player.yaw, player.pitch);
      const aiming = Boolean(input.held & Action.Ads);
      // Read before this shot's bloom is added, so the first round of a burst still
      // goes exactly where it was aimed.
      const spread = (aiming ? weapon.adsSpread : weapon.hipSpread) * (1 + player.bloom);
      this.applyRecoilKick(weapon, aiming);
      events.push(this.event('shot', origin, undefined, undefined, {
        origin: [origin.x, origin.y, origin.z],
        sourceEntityId: player.id,
      }));
      // One trace per pellet, so a shotgun shell reads as a spread pattern.
      for (let pellet = 0; pellet < weapon.pellets; pellet += 1) {
        this.tracePellet(origin, baseDirection, spread, weapon, events);
      }
    } else if (player.action === 'firing' && player.fireCooldown === 0) {
      player.action = 'neutral';
    }
  }

  /**
   * One swing of the blade, light or heavy.
   *
   * The whole of the reach, the arc, the damage and the recovery are in `melee` in the
   * content config, and the comment there explains why the light's envelope is as
   * generous as it is and what the heavy is for.
   *
   * Both swings resolve against whatever is inside the arc rather than along the look
   * vector, which is the melee equivalent of the aim assist: the player points the blade
   * at a fight and the simulation decides where the edge landed. The difference is how
   * many things it landed on -- the light takes the nearest, the heavy takes all of
   * them, which is what makes it the crowd answer rather than a bigger number.
   */
  private swing(events: GameEvent[], kind: 'light' | 'heavy'): void {
    const player = this.player;
    const profile = kind === 'heavy' ? this.blade.heavy : this.blade.light;
    player.action = 'melee';
    player.meleeTimer = profile.seconds;
    player.meleeDuration = profile.seconds;
    const origin = this.cameraPosition();
    const direction = directionFromLook(player.yaw, player.pitch);
    const struck = kind === 'heavy'
      ? this.botsInArc(origin, direction, profile.range, profile.arcCosine)
      : [this.closestBotInArc(origin, direction, profile.range, profile.arcCosine)].filter((bot): bot is BotState => bot !== null);
    events.push(this.event('melee', origin, undefined, struck.length, {
      sourceEntityId: player.id,
      // Names the nearest of them, which is the one presentation anchors to.
      targetEntityId: struck[0]?.id,
      heavy: kind === 'heavy',
    }));
    if (struck.length === 0) return;
    for (const target of struck) {
      this.damageBot(target, profile.damage, events, this.positionOf(target.body), {
        sourceEntityId: player.id,
        headshot: false,
      }, kind === 'heavy' ? this.blade.heavy.shieldFloor : undefined);
    }
    // A swing that connected extends the chain, and the two swings are different link
    // kinds -- so the no-repeat rule means mashing one of them pays exactly once and
    // growing a chain means reaching for the other, or for the kit.
    this.addComboLink(events, kind === 'heavy' ? 'heavy' : 'slash');
  }

  /**
   * Which weapon is in the player's hands.
   *
   * This is in the simulation because two layers were deciding it independently.
   * `ViewmodelPresenter` owned a private 0.95 s timer that chose which model to draw and
   * the HUD had no way to ask it, so the ammo corner read `CARBINE 30/120` over a blade.
   * The decision belongs to one place and both presentation layers read the field.
   *
   * Run after `updateCombat`, so a shot fired on this tick is in hand on this tick's
   * snapshot rather than the next one. A swing clears the hold outright: the blade is
   * what does the swinging, and the previous arrangement animated a blade swing on a gun
   * for up to 0.95 s after a shot.
   */
  private updateInHand(_dt: number): void {
    // Nothing to decay any more: `inHand` is what the player last selected, and only a
    // slot key, the swap key or a checkpoint restore moves it. Kept as a seam because
    // the ordering comment above still holds -- whatever decides this has to run after
    // `updateCombat` so a switch made on this tick is in the snapshot on this tick.
  }

  /**
   * Moves the aim, rather than only the viewmodel. The kick is recorded so recovery
   * knows exactly how much of the current view it is entitled to take back.
   */
  private applyRecoilKick(weapon: WeaponDefinition, aiming: boolean): void {
    const player = this.player;
    const factor = aiming ? recoilAdsFactor : 1;
    const pitchKick = weapon.recoilPitch * factor;
    const yawKick = (this.random.next() - 0.5) * 2 * weapon.recoilYaw * factor;
    player.pitch = clamp(player.pitch + pitchKick, -1.48, 1.48);
    player.yaw += yawKick;
    player.recoilPitch += pitchKick;
    player.recoilYaw += yawKick;
    player.recoilHold = recoilHoldSeconds;
    player.bloom = Math.min(weapon.bloomMax, player.bloom + weapon.bloomPerShot);
  }

  private tracePellet(
    origin: RAPIER.Vector,
    baseDirection: RAPIER.Vector,
    spread: number,
    weapon: WeaponDefinition,
    events: GameEvent[],
  ): void {
    const player = this.player;
    // Halved because the authored spread values were tuned against the previous
    // full-width box, and a cone of half-angle `spread / 2` covers the same envelope.
    const direction = coneDirection(baseDirection, spread / 2, this.random);
    const hit = this.world.castRayAndGetNormal(new RAPIER.Ray(origin, direction), weapon.range, true, undefined, undefined, player.collider, player.body);
    const impact: Vec3 = hit
      ? [origin.x + direction.x * hit.timeOfImpact, origin.y + direction.y * hit.timeOfImpact, origin.z + direction.z * hit.timeOfImpact]
      : [origin.x + direction.x * weapon.range, origin.y + direction.y * weapon.range, origin.z + direction.z * weapon.range];
    const entityId = hit ? this.colliderEntity.get(hit.collider.handle) : undefined;
    const bot = this.bots.find((candidate) => candidate.id === entityId && candidate.alive);
    const botPosition = bot?.body.translation();
    const headshot = botPosition ? impact[1] > botPosition.y + BOT_HEADSHOT_HEIGHT : undefined;
    const normal = hit ? this.vectorOf(hit.normal) : undefined;
    const surface = hit ? this.surfaceForCollider(hit.collider.handle) : undefined;
    events.push(this.event('impact', impact, undefined, undefined, {
      origin: [origin.x, origin.y, origin.z],
      sourceEntityId: player.id,
      targetEntityId: bot?.id,
      normal,
      surface,
      headshot,
    }));
    if (bot) {
      this.damageBot(bot, weapon.damage * (headshot ? weapon.headshotMultiplier : 1), events, impact, {
        sourceEntityId: player.id,
        normal,
        headshot,
      });
    }
  }

  /**
   * What the player is holding, and it is only ever their choice.
   *
   * Three slots on three keys -- the blade first, because it is the primary verb -- and
   * a swap key that cycles the same three in the same order. Nothing else moves it: the
   * previous arrangement drew a gun whenever one was fired and put the blade back 0.95 s
   * later, so the attack button meant different things at different times without the
   * player having asked for either.
   *
   * A short ready timer blocks firing after any change, so switching is a real decision
   * rather than a free stat swap mid-burst.
   */
  private updateWeaponSwitch(input: InputFrame): void {
    const player = this.player;
    // The cycle order is blade, gun one, gun two -- the order the keys are in.
    const carried = player.weapons.length;
    const current = player.inHand === 'blade' ? 0 : player.activeSlot + 1;
    const requested = input.pressed & Action.SelectBlade
      ? 0
      : input.pressed & Action.SelectGunOne
        ? 1
        : input.pressed & Action.SelectGunTwo
          ? 2
          : input.pressed & Action.WeaponSwap
            ? (current + 1) % (carried + 1)
            : current;
    if (requested === current || requested > carried) return;
    const wasGun = player.inHand === 'gun';
    const previousSlot = player.activeSlot;
    player.inHand = requested === 0 ? 'blade' : 'gun';
    if (requested > 0) player.activeSlot = requested - 1;
    // The accumulator belongs to the weapon that produced it, and the new one recovers
    // at its own rate; carrying it over would apply one gun's climb to another's curve.
    player.recoilPitch = 0;
    player.recoilYaw = 0;
    player.bloom = 0;
    // A reload cannot survive the magazine leaving the player's hands, whichever
    // direction they went.
    if (player.action === 'reloading') {
      player.action = 'neutral';
      player.reloadTimer = 0;
    }
    // Only a *gun* swap costs the ready beat. Putting the blade away and taking it out
    // is a change of hands rather than a change of magazine, and this game is fast
    // enough that charging a third of a second for it would turn the selection the
    // player just gained into something they avoid using.
    if (!(wasGun && player.inHand === 'gun' && previousSlot !== player.activeSlot)) return;
    player.weaponReadyTimer = WEAPON_SWAP_SECONDS;
    player.fireCooldown = Math.max(player.fireCooldown, WEAPON_SWAP_SECONDS);
  }

  private updateBots(dt: number, events: GameEvent[]): void {
    const playerPosition = this.player.body.translation();
    for (const bot of this.bots) {
      if (!bot.alive || !bot.active) continue;
      bot.fireCooldown -= dt;
      bot.decisionCooldown -= dt;
      const position = bot.body.translation();
      // Leashed to its own room. Beyond the leash the hostile walks home instead of
      // chasing, which is what keeps an arena an arena -- see `botLeashMetres`.
      const [homeX, homeY, homeZ] = bot.spawnPosition;
      const reachable = Math.hypot(playerPosition.x - homeX, playerPosition.y - homeY, playerPosition.z - homeZ) <= botLeashMetres;
      const pursuit: Vec3 = reachable
        ? [playerPosition.x, playerPosition.y, playerPosition.z]
        : [homeX, homeY, homeZ];
      if (bot.decisionCooldown <= 0) {
        bot.decisionCooldown = 0.1;
        if (this.random.next() < 0.08) bot.strafe *= -1;
        bot.waypoint = this.navigation.nextWaypoint([position.x, position.y, position.z], pursuit);
      }
      const target = bot.waypoint ?? pursuit;
      const dx = target[0] - position.x;
      const dz = target[2] - position.z;
      const distance = Math.hypot(dx, dz) || 1;
      const playerDistance = Math.hypot(playerPosition.x - position.x, playerPosition.z - position.z) || 1;
      const toward = { x: dx / distance, z: dz / distance };
      const rangeError = bot.waypoint
        ? distance - 0.35
        : distance - (reachable ? bot.profile.preferredRange : 0.5);
      const forwardAmount = clamp(rangeError, -1, 1);
      const strafeAmount = bot.profile.kind === 'ranged' ? bot.strafe * 0.65 : bot.strafe * 0.2;
      const vx = (toward.x * forwardAmount - toward.z * strafeAmount) * bot.profile.moveSpeed;
      const vz = (toward.z * forwardAmount + toward.x * strafeAmount) * bot.profile.moveSpeed;
      bot.velocityY -= movementProfile.gravity * dt;
      const linkStep = bot.waypoint && Math.abs(target[1] - position.y) > 0.45
        ? clamp(target[1] - position.y, -bot.profile.moveSpeed * dt, bot.profile.moveSpeed * dt)
        : bot.velocityY * dt;
      // Without a baked navmesh the bots steer straight at the player, which walks
      // them off ledges. Only guard the unguided case; authored navmesh paths and
      // off-mesh links are allowed to drop on purpose.
      const step = bot.waypoint || !bot.grounded
        ? { x: vx * dt, z: vz * dt }
        : this.groundedStep(position, vx * dt, vz * dt);
      this.botController.computeColliderMovement(
        bot.collider,
        { x: step.x, y: linkStep, z: step.z },
        undefined,
        undefined,
        (collider) => collider.handle !== bot.collider.handle,
      );
      const movement = this.botController.computedMovement();
      const grounded = this.botController.computedGrounded();
      if (grounded && bot.velocityY < 0) bot.velocityY = 0;
      const inverseDt = dt > 0 ? 1 / dt : 0;
      bot.velocity = { x: movement.x * inverseDt, y: movement.y * inverseDt, z: movement.z * inverseDt };
      bot.grounded = grounded;
      bot.body.setNextKinematicTranslation({ x: position.x + movement.x, y: position.y + movement.y, z: position.z + movement.z });

      // Anything that still ends up in the void is returned to its spawn rather
      // than falling forever.
      if (position.y < VOID_Y) this.returnBotToSpawn(bot);

      this.turnBot(bot, position, playerPosition, dt);
      this.updateBotFire(bot, position, playerDistance, dt, events);
    }
  }

  /**
   * A bot with no turn rate simply looks at the player, which is what the snapshot
   * used to derive inline. One with a turn rate has to swing round, and that lag is
   * the whole mechanic: it is what makes a shield something to get around.
   */
  private turnBot(bot: BotState, position: RAPIER.Vector, playerPosition: RAPIER.Vector, dt: number): void {
    const bearing = Math.atan2(playerPosition.x - position.x, playerPosition.z - position.z);
    if (bot.profile.turnRate === undefined) {
      bot.facingYaw = bearing;
      return;
    }
    const step = bot.profile.turnRate * dt;
    bot.facingYaw = wrapAngle(bot.facingYaw + clamp(wrapAngle(bearing - bot.facingYaw), -step, step));
  }

  /**
   * Cosine of the angle between where the bot is pointed and where the player is,
   * measured on the horizontal plane. Getting above a bulwark is not the same as
   * getting behind it: the plate is carried in front of the body, not over it.
   */
  private facingCosine(bot: BotState, target: RAPIER.Vector): number {
    const position = bot.body.translation();
    const dx = target.x - position.x;
    const dz = target.z - position.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) return 1;
    return (dx * Math.sin(bot.facingYaw) + dz * Math.cos(bot.facingYaw)) / length;
  }

  /**
   * Firing is two stage. The bot commits, telegraphs, and only then resolves the
   * shot as a real trace from its muzzle, so breaking the line during the window
   * defeats it. Aim error grows with the player's speed, which makes the movement
   * kit the defence rather than a separate health economy.
   */
  private updateBotFire(bot: BotState, position: RAPIER.Vector, playerDistance: number, dt: number, events: GameEvent[]): void {
    const muzzle = { x: position.x, y: position.y + BOT_MUZZLE_HEIGHT, z: position.z };
    if (bot.windupTimer > 0) {
      bot.windupTimer = Math.max(0, bot.windupTimer - dt);
      if (bot.windupTimer === 0) this.resolveBotShot(bot, muzzle, playerDistance, events);
      return;
    }
    if (bot.fireCooldown > 0 || playerDistance >= bot.profile.preferredRange * 1.5) return;
    // A bot that has to aim its whole body cannot shoot what it has not turned to.
    // Flanking a bulwark takes its damage away as well as its plate.
    if (bot.profile.fireArcCosine !== undefined && this.facingCosine(bot, this.player.body.translation()) < bot.profile.fireArcCosine) return;
    if (!this.hasLineOfSight(position, this.player.body.translation(), bot.collider)) return;
    // The cooldown runs during the telegraph, so shot-to-shot still measures the
    // authored interval. The telegraph buys the player reaction time; it is not a
    // back-door damage nerf, and the only DPS a bot loses is to actual misses.
    bot.fireCooldown = bot.profile.fireInterval;
    bot.windupTimer = bot.profile.windupSeconds;
    const speed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
    // Locked in at commit time so a telegraph can never be re-rolled into a hit.
    bot.windupSpread = bot.profile.baseSpread + speed * bot.profile.spreadPerSpeed;
    events.push(this.event('enemyTelegraph', muzzle, bot.id, bot.profile.windupSeconds, {
      origin: [muzzle.x, muzzle.y, muzzle.z],
      sourceEntityId: bot.id,
      targetEntityId: this.player.id,
    }));
  }

  private resolveBotShot(bot: BotState, muzzle: RAPIER.Vector, playerDistance: number, events: GameEvent[]): void {
    const target = this.cameraPosition();
    const aim = normalize3({ x: target.x - muzzle.x, y: target.y - muzzle.y, z: target.z - muzzle.z });
    const direction = coneDirection(aim, bot.windupSpread, this.random);
    const range = Math.max(bot.profile.preferredRange, playerDistance) * BOT_SHOT_RANGE_FACTOR;
    const hit = this.world.castRay(
      new RAPIER.Ray(muzzle, direction), range, true, undefined, undefined, bot.collider, bot.body,
    );
    const origin: Vec3 = [muzzle.x, muzzle.y, muzzle.z];
    const travel = hit ? hit.timeOfImpact : range;
    const end: Vec3 = [muzzle.x + direction.x * travel, muzzle.y + direction.y * travel, muzzle.z + direction.z * travel];
    const connected = hit?.collider.handle === this.player.collider.handle;
    // `targetEntityId` names who was shot at; `value` reports what actually landed,
    // so a miss is still attributable and still audible.
    const damage = connected ? bot.profile.damage : 0;
    events.push(this.event('enemyAttack', end, bot.id, damage, {
      origin,
      sourceEntityId: bot.id,
      targetEntityId: this.player.id,
    }));
    if (!connected) return;
    // A perfect dodge: the shot was committed, telegraphed, aimed and on target, and
    // the player was inside their invulnerability frames when it resolved. That is why
    // this check lives here rather than at the moment of the dash -- dodging has to
    // mean a round that was going to land did not, which cannot be farmed by dashing
    // at nothing. It pays a chain link, so defending extends a combo rather than
    // interrupting one, and the no-repeat rule bounds it to once per chain.
    if (this.player.invulnerableTimer > 0) {
      events.push(this.event('dodge', this.cameraPosition(), this.player.id, damage, {
        origin,
        sourceEntityId: bot.id,
        targetEntityId: this.player.id,
      }));
      this.addComboLink(events, 'dodge', this.blade.chain.dodgeLinks);
      return;
    }
    this.player.health -= damage;
    events.push(this.event('hit', this.cameraPosition(), this.player.id, damage, {
      origin,
      sourceEntityId: bot.id,
      targetEntityId: this.player.id,
      headshot: false,
    }));
  }

  /**
   * Keeps an unguided bot on its platform: the full step is used when there is
   * ground under it, otherwise the axes are tried separately so bots can still
   * slide along an edge instead of stopping dead.
   */
  private groundedStep(position: RAPIER.Vector, stepX: number, stepZ: number): { x: number; z: number } {
    if (stepX === 0 && stepZ === 0) return { x: 0, z: 0 };
    if (this.hasGroundAt(position, stepX, stepZ)) return { x: stepX, z: stepZ };
    if (stepX !== 0 && this.hasGroundAt(position, stepX, 0)) return { x: stepX, z: 0 };
    if (stepZ !== 0 && this.hasGroundAt(position, 0, stepZ)) return { x: 0, z: stepZ };
    return { x: 0, z: 0 };
  }

  private hasGroundAt(position: RAPIER.Vector, stepX: number, stepZ: number): boolean {
    // Probe a fixed distance along the direction of travel. A single tick's step is
    // only centimetres, so scaling by it would sample under the bot's own feet and
    // only notice the ledge once the bot had already left it.
    const length = Math.hypot(stepX, stepZ) || 1;
    const origin = {
      x: position.x + (stepX / length) * BOT_LEDGE_LOOKAHEAD,
      y: position.y,
      z: position.z + (stepZ / length) * BOT_LEDGE_LOOKAHEAD,
    };
    return this.world.castRay(
      new RAPIER.Ray(origin, DOWN), BOT_COLLIDER_BOTTOM + BOT_MAX_DROP, true, undefined, undefined,
      undefined, undefined, (collider) => this.staticColliderIds.has(collider.handle),
    ) !== null;
  }

  /**
   * Places a bot's spawn exactly on the surface beneath it. Authored spawn heights
   * were tuned against the old capsule, so deriving the resting height keeps every
   * level correct instead of requiring each spawn to be re-authored.
   */
  private groundBotSpawn(bot: BotState): void {
    const [x, y, z] = bot.spawnPosition;
    const hit = this.world.castRay(
      new RAPIER.Ray({ x, y: y + BOT_SPAWN_PROBE, z }, DOWN),
      BOT_SPAWN_PROBE + BOT_COLLIDER_BOTTOM + BOT_MAX_DROP,
      true, undefined, undefined, undefined, undefined,
      (collider) => this.staticColliderIds.has(collider.handle),
    );
    if (!hit) return;
    const surfaceY = y + BOT_SPAWN_PROBE - hit.timeOfImpact;
    const resting = surfaceY + BOT_COLLIDER_BOTTOM;
    bot.spawnPosition = [x, resting, z];
    bot.body.setTranslation({ x, y: resting, z }, true);
    bot.body.setNextKinematicTranslation({ x, y: resting, z });
  }

  private returnBotToSpawn(bot: BotState): void {
    const [x, y, z] = bot.spawnPosition;
    bot.body.setTranslation({ x, y, z }, true);
    bot.body.setNextKinematicTranslation({ x, y, z });
    bot.velocityY = 0;
    bot.velocity = { x: 0, y: 0, z: 0 };
    bot.grounded = false;
    bot.waypoint = null;
    bot.windupTimer = 0;
    bot.windupSpread = 0;
  }

  private updateEncounterActivation(): void {
    const player = this.player.body.translation();
    const current = this.level.encounters.find((encounter) => !this.completedEncounters.has(encounter.id));
    if (!current || this.activeEncounters.has(current.id)) return;
    const distance = Math.hypot(player.x - current.checkpoint[0], player.y - current.checkpoint[1], player.z - current.checkpoint[2]);
    if (distance > 28) return;
    this.activeEncounters.add(current.id);
    this.liveWaves.set(current.id, 0);
    this.activateWave(current.id, 0);
  }

  /** Seats every hostile of one wave at its authored spawn and lets it act. */
  private activateWave(encounterId: string, wave: number): void {
    for (const bot of this.bots) {
      if (bot.encounterId !== encounterId || bot.wave !== wave || !bot.alive) continue;
      bot.active = true;
      bot.body.setEnabled(true);
      const [x, y, z] = bot.spawnPosition;
      bot.body.setTranslation({ x, y, z }, true);
      bot.body.setNextKinematicTranslation({ x, y, z });
      bot.velocityY = 0;
      bot.velocity = { x: 0, y: 0, z: 0 };
      bot.grounded = false;
      bot.windupTimer = 0;
      bot.windupSpread = 0;
    }
  }

  /**
   * Brings on the next wave of a room the moment the last of the current one dies.
   *
   * Run before `updateObjectives`, so the wave that replaces a cleared one is live on
   * the same tick and the room is never briefly empty. It cannot complete an encounter
   * early either way: a wave that has not been activated is still `alive`, so the
   * completion check sees it.
   */
  private updateWaves(events: GameEvent[]): void {
    for (const encounter of this.level.encounters) {
      if (this.completedEncounters.has(encounter.id) || !this.activeEncounters.has(encounter.id)) continue;
      const wave = this.liveWaves.get(encounter.id) ?? 0;
      if (this.bots.some((bot) => bot.encounterId === encounter.id && bot.wave === wave && bot.alive)) continue;
      const next = wave + 1;
      if (!this.bots.some((bot) => bot.encounterId === encounter.id && bot.wave === next)) continue;
      this.liveWaves.set(encounter.id, next);
      this.activateWave(encounter.id, next);
      events.push(this.event('wave', encounter.checkpoint, undefined, next + 1));
    }
  }

  /** How many waves a room was authored with. One for a room without any. */
  private waveCount(encounterId: string): number {
    let highest = 0;
    for (const bot of this.bots) {
      if (bot.encounterId === encounterId) highest = Math.max(highest, bot.wave);
    }
    return highest + 1;
  }

  private updateObjectives(events: GameEvent[]): void {
    for (const encounter of this.level.encounters) {
      if (this.completedEncounters.has(encounter.id)) continue;
      if (!this.activeEncounters.has(encounter.id)) continue;
      const relevant = this.bots.filter((bot) => encounter.requiredBotIds.includes(bot.spawnId));
      if (relevant.length > 0 && relevant.every((bot) => !bot.alive)) {
        this.completedEncounters.add(encounter.id);
        this.player.score += Math.round(runScoring.encounterScore * this.modifierMultiplier());
        // Recorded before the checkpoint capture below, so a restore keeps it.
        this.splits.push({ encounterId: encounter.id, label: encounter.label, seconds: this.elapsedSeconds });
        this.checkpoint = {
          ...this.captureCheckpoint(),
          position: encounter.checkpoint,
          health: PLAYER_MAX_HEALTH,
        };
        events.push(this.event('checkpoint', encounter.checkpoint));
        events.push(this.event('split', encounter.checkpoint, undefined, this.elapsedSeconds));
        for (const gate of this.level.primitives.filter((primitive) => primitive.gateForEncounterId === encounter.id)) {
          events.push(this.event('gateOpen', gate.transform.position, undefined, undefined, { gateId: gate.id }));
        }
        this.syncEncounterGates();
        this.releaseOpenedGateGrapple(events);
      }
    }
    const playerPosition = this.player.body.translation();
    const dx = playerPosition.x - this.level.exit[0];
    const dy = playerPosition.y - this.level.exit[1];
    const dz = playerPosition.z - this.level.exit[2];
    if (this.completedEncounters.size === this.level.encounters.length && Math.hypot(dx, dy, dz) < 4) {
      this.completed = true;
      this.player.score += Math.max(0, Math.round(runScoring.completionBudgetSeconds - this.elapsedSeconds));
      events.push(this.event('complete', this.level.exit));
    }
  }

  /**
   * Every source of damage to a bot is the player, so the shield arc is measured
   * against where the player is standing rather than where the round happened to
   * land: what a plate stops is a shot from in front of it.
   */
  private shieldScale(bot: BotState): number {
    const shield = bot.profile.shield;
    if (!shield) return 1;
    return this.facingCosine(bot, this.player.body.translation()) >= shield.arcCosine ? shield.damageScale : 1;
  }

  private damageBot(
    bot: BotState,
    damage: number,
    events: GameEvent[],
    position: Vec3,
    details: Pick<GameEvent, 'sourceEntityId' | 'headshot' | 'normal' | 'surface'>,
    /**
     * Least a shield arc may scale this hit to. Only the heavy passes one: it is the
     * blade's answer to a guard there is no room to get around, and it is deliberately
     * the inefficient answer rather than a bypass.
     */
    shieldFloor?: number,
  ): void {
    const scale = Math.max(this.shieldScale(bot), shieldFloor ?? 0);
    const dealt = damage * scale;
    bot.health -= dealt;
    events.push(this.event('hit', position, bot.id, dealt, {
      ...details,
      targetEntityId: bot.id,
      deflected: scale < 1,
    }));
    if (bot.health <= 0) {
      bot.alive = false;
      bot.health = 0;
      bot.body.setEnabled(false);
      if (this.checkpoint && !this.checkpoint.defeatedBotIds.includes(bot.id)) {
        this.checkpoint = { ...this.checkpoint, defeatedBotIds: [...this.checkpoint.defeatedBotIds, bot.id] };
      }
      // Paid at the multiplier the chain had already reached, then the kill extends
      // it. A headshot is worth two links, so precision feeds the chain as well.
      const award = Math.round(runScoring.killScore * this.comboMultiplier() * this.modifierMultiplier());
      this.player.score += award;
      events.push(this.event('kill', position, bot.id, award, {
        ...details,
        targetEntityId: bot.id,
      }));
      // Life from damage, and the only healing in the game -- see `lifesteal`. Paid at the
      // same multiplier the score was, before the kill's own link lands, so the two agree
      // about what the chain was worth at the moment the body went down.
      const healed = this.heal(lifestealForKill(this.comboMultiplier()));
      if (healed > 0) {
        events.push(this.event('heal', this.cameraPosition(), this.player.id, healed, {
          sourceEntityId: bot.id,
        }));
      }
      // A style may pay more for a kill, and a headshot still doubles whatever that is.
      this.addComboLink(events, 'kill', this.blade.chain.killLinks * (details.headshot ? 2 : 1));
    }
  }

  /**
   * Returns health to the player, bounded by what is missing. Returns what was actually
   * given, so a kill at full health reports nothing rather than an event with a zero on
   * it -- presentation should not flash a heal that did not happen.
   */
  private heal(amount: number): number {
    const player = this.player;
    const healed = Math.min(amount, PLAYER_MAX_HEALTH - player.health);
    if (healed <= 0) return 0;
    player.health += healed;
    return healed;
  }

  private findWall(position: RAPIER.Vector, yaw: number): { side: number; normal: RAPIER.Vector; collider: Collider } | null {
    const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
    for (const side of [-1, 1]) {
      const direction = { x: right.x * side, y: 0, z: right.z * side };
      const hit = this.world.castRayAndGetNormal(
        new RAPIER.Ray(position, direction),
        0.72,
        true,
        undefined,
        undefined,
        this.player.collider,
        this.player.body,
      );
      if (hit && Math.abs(hit.normal.y) < 0.35 && this.traversalForCollider(hit.collider.handle)?.wallRun) {
        return { side, normal: hit.normal, collider: hit.collider };
      }
    }
    return null;
  }

  private findRechargeWall(position: RAPIER.Vector, yaw: number): { collider: Collider } | null {
    const forward = forwardFromYaw(yaw);
    for (const multiplier of [1, -1]) {
      const hit = this.world.castRayAndGetNormal(
        new RAPIER.Ray(position, { x: forward.x * multiplier, y: 0, z: forward.z * multiplier }),
        0.72,
        true,
        undefined,
        undefined,
        this.player.collider,
        this.player.body,
      );
      if (hit && Math.abs(hit.normal.y) < 0.35 && this.traversalForCollider(hit.collider.handle)?.wallRun) return { collider: hit.collider };
    }
    return null;
  }

  private canVault(position: RAPIER.Vector, forward: { x: number; z: number }): boolean {
    const lower = new RAPIER.Ray({ x: position.x, y: position.y - 0.25, z: position.z }, { x: forward.x, y: 0, z: forward.z });
    const upper = new RAPIER.Ray({ x: position.x, y: position.y + 0.65, z: position.z }, { x: forward.x, y: 0, z: forward.z });
    const lowerHit = this.world.castRay(lower, 1.1, true, undefined, undefined, this.player.collider, this.player.body);
    const upperHit = this.world.castRay(upper, 1.1, true, undefined, undefined, this.player.collider, this.player.body);
    if (!lowerHit || upperHit) return false;
    const traversal = this.traversalForCollider(lowerHit.collider.handle);
    return Boolean(traversal?.vault || traversal?.mantle);
  }

  private hasLineOfSight(from: RAPIER.Vector, to: RAPIER.Vector, exclude: Collider): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    const direction = { x: dx / distance, y: dy / distance, z: dz / distance };
    const hit = this.world.castRay(new RAPIER.Ray(from, direction), distance, true, undefined, undefined, exclude, exclude.parent() ?? undefined);
    return !hit || hit.collider.handle === this.player.collider.handle;
  }

  /** Every live bot inside a cone from `origin`, nearest first. What a heavy sweeps. */
  private botsInArc(origin: RAPIER.Vector, direction: RAPIER.Vector, range: number, arcCosine: number): BotState[] {
    const found: { bot: BotState; distance: number }[] = [];
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const position = bot.body.translation();
      const dx = position.x - origin.x;
      const dy = position.y - origin.y;
      const dz = position.z - origin.z;
      const distance = Math.hypot(dx, dy, dz);
      const dot = (dx * direction.x + dy * direction.y + dz * direction.z) / Math.max(distance, 0.001);
      if (distance < range && dot > arcCosine) found.push({ bot, distance });
    }
    return found.sort((a, b) => a.distance - b.distance).map((entry) => entry.bot);
  }

  /**
   * Nearest live bot inside a cone from `origin`. The cone is a parameter rather than
   * the constant `0.55` it used to be, because the blade's arc is authored tuning now
   * and the callers want different widths.
   */
  private closestBotInArc(origin: RAPIER.Vector, direction: RAPIER.Vector, range: number, arcCosine: number): BotState | null {
    let nearest: BotState | null = null;
    let nearestDistance = range;
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const position = bot.body.translation();
      const dx = position.x - origin.x;
      const dy = position.y - origin.y;
      const dz = position.z - origin.z;
      const distance = Math.hypot(dx, dy, dz);
      const dot = (dx * direction.x + dy * direction.y + dz * direction.z) / Math.max(distance, 0.001);
      if (distance < nearestDistance && dot > arcCosine) {
        nearest = bot;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  private comboMultiplier(): number {
    const links = Math.min(this.player?.comboLinks ?? 0, comboScoring.maxLinks);
    return 1 + links * (comboScoring.linkStep + this.blade.chain.linkStepBonus);
  }

  /**
   * Extends the chain, if this tech has not already been spent on it, and pays the
   * link out at the multiplier it just reached. See `comboScoring` for why repeats
   * are refused and why the first link is unpaid.
   */
  private addComboLink(events: GameEvent[], kind: ComboLinkKind, links = 1): void {
    const player = this.player;
    if (player.locomotion === 'dead') return;
    if (kind !== 'kill') {
      if (player.comboKinds.includes(kind)) return;
      player.comboKinds.push(kind);
    }
    let award = 0;
    for (let index = 0; index < links; index += 1) {
      player.comboLinks += 1;
      if (player.comboLinks >= comboScoring.payFromLink) {
        const linkRate = comboScoring.linkScore * (1 + (this.modifier?.linkBonus ?? 0));
        award += Math.round(linkRate * this.comboMultiplier() * this.modifierMultiplier());
      }
    }
    player.score += award;
    player.comboTimer = this.comboWindowSeconds();
    this.comboPeak = Math.max(this.comboPeak, player.comboLinks);
    events.push(this.event('comboLink', this.positionOf(player.body), player.id, player.comboLinks));
  }

  /** How long a chain survives on this blade. */
  private comboWindowSeconds(): number {
    return comboScoring.linkWindowSeconds + this.blade.chain.windowBonusSeconds;
  }

  private breakCombo(events: GameEvent[]): void {
    const player = this.player;
    player.comboKinds = [];
    player.comboTimer = 0;
    if (player.comboLinks === 0) return;
    events.push(this.event('comboBreak', this.cameraPosition(), player.id, player.comboLinks));
    player.comboLinks = 0;
  }

  private eyeHeight(): number {
    return playerCapsule.standingEye
      + (playerCapsule.crouchedEye - playerCapsule.standingEye) * (this.player?.stance ?? 0);
  }

  private cameraPosition(): RAPIER.Vector {
    const position = this.player.body.translation();
    return { x: position.x, y: position.y + this.eyeHeight(), z: position.z };
  }

  private snapshot(): SimulationSnapshot {
    const playerPosition = this.player ? this.positionOf(this.player.body) : [0, 0, 0] as const;
    const active = this.player?.weapons[this.player.activeSlot];
    const nextEncounter = this.level?.encounters.find((encounter) => !this.completedEncounters.has(encounter.id));
    return {
      tick: this.tick,
      elapsedSeconds: this.elapsedSeconds,
      entities: [
        {
          id: this.player?.id ?? 0,
          kind: 'player' as const,
          position: playerPosition,
          velocity: this.player ? this.vectorOf(this.player.velocity) : [0, 0, 0],
          rotationY: this.player?.yaw ?? 0,
          grounded: this.player?.grounded ?? false,
          aimPitch: this.player?.pitch ?? 0,
          health: this.player?.health ?? 0,
          maxHealth: PLAYER_MAX_HEALTH,
        },
        ...this.bots.filter((bot) => bot.alive && bot.active).map((bot) => {
          const botPosition = bot.body.translation();
          const playerAim = this.cameraPosition();
          return {
            id: bot.id,
            kind: 'bot' as const,
            position: this.positionOf(bot.body),
            velocity: this.vectorOf(bot.velocity),
            rotationY: bot.facingYaw,
            grounded: bot.grounded,
            aimPitch: Math.atan2(playerAim.y - (botPosition.y + 0.58), Math.hypot(playerAim.x - botPosition.x, playerAim.z - botPosition.z)),
            health: bot.health,
            maxHealth: bot.profile.health,
            profile: bot.profile.kind,
          };
        }),
      ],
      camera: {
        position: [playerPosition[0], playerPosition[1] + this.eyeHeight(), playerPosition[2]],
        yaw: this.player?.yaw ?? 0,
        pitch: this.player?.pitch ?? 0,
        fov: this.player?.ads ? Math.max(40, this.settings.fov - (active?.stats.adsZoom ?? 20)) : this.settings.fov,
      },
      player: {
        health: Math.max(0, this.player?.health ?? 0),
        ammo: active?.ammo ?? 0,
        reserveAmmo: active?.reserveAmmo ?? 0,
        magazineSize: active?.stats.magazineSize ?? 1,
        weapons: {
          activeSlot: this.player?.activeSlot ?? 0,
          ready: (this.player?.weaponReadyTimer ?? 0) === 0,
          inHand: this.player?.inHand ?? 'blade',
          blade: this.blade.id,
          slots: this.player?.weapons.map((slot) => ({
            name: slot.build.name,
            chassisId: slot.build.chassisId,
            parts: slot.build.parts,
            ammo: slot.ammo,
            reserveAmmo: slot.reserveAmmo,
          })) ?? [],
        },
        locomotion: this.player?.locomotion ?? 'dead',
        action: this.player?.action ?? 'neutral',
        adsProgress: this.player?.ads ? 1 : 0,
        actionProgress: this.actionProgress(),
        spreadBloom: this.player
          ? clamp(this.player.bloom / Math.max(0.001, active?.stats.bloomMax ?? 1), 0, 1)
          : 0,
        stance: this.player?.stance ?? 0,
        speed: this.player ? Math.hypot(this.player.velocity.x, this.player.velocity.z) : 0,
        airCharge: this.player?.airCharge ?? 0,
        grapple: {
          active: Boolean(this.player?.grappleAnchor),
          anchor: this.player?.grappleAnchor ?? null,
          ropeLength: this.player?.grappleRopeLength ?? 0,
          cooldown: this.player?.grappleCooldown ?? 0,
          available: Boolean(this.player && !this.player.grappleAnchor && this.player.grappleCooldown <= 0),
          aim: this.world ? this.grappleAim() : null,
        },
        dashAvailable: Boolean(this.player && (this.player.grounded || this.player.airCharge > 0) && this.player.dashTimer <= 0),
        dodge: {
          invulnerable: (this.player?.invulnerableTimer ?? 0) > 0,
          ready: (this.player?.dodgeCooldown ?? 0) === 0,
          cooldown: this.player?.dodgeCooldown ?? 0,
        },
        jumpCancelAvailable: Boolean(this.player && this.player.dashWasGrounded && this.player.dashTimer > 0 && this.player.dashElapsed >= 2 / 60),
        wallJumpAvailable: this.player?.wallJumpReady ?? false,
        lockedTargetId: this.player?.lockedTargetId ?? null,
        score: this.player?.score ?? 0,
        combo: {
          links: this.player?.comboLinks ?? 0,
          multiplier: this.comboMultiplier(),
          window: Math.min(1, (this.player?.comboTimer ?? 0) / this.comboWindowSeconds()),
          peakLinks: this.comboPeak,
        },
        deaths: this.deaths,
        awaitingRespawn: this.player?.locomotion === 'dead',
      },
      splits: this.splits,
      objective: this.completed ? 'Run complete' : nextEncounter ? `Clear: ${nextEncounter.label}` : 'Reach the finish gate',
      wave: nextEncounter && this.activeEncounters.has(nextEncounter.id)
        ? { current: (this.liveWaves.get(nextEncounter.id) ?? 0) + 1, total: this.waveCount(nextEncounter.id) }
        : { current: 0, total: 0 },
      completed: this.completed,
      // Includes both collider IDs and encounter IDs. Presentation bindings may
      // target either, including an encounter that has no physical gate proxy.
      openGateIds: this.openGateIds,
    };
  }

  private positionOf(body: RigidBody): Vec3 {
    const position = body.translation();
    return [position.x, position.y, position.z];
  }

  private vectorOf(vector: RAPIER.Vector): Vec3 {
    return [vector.x, vector.y, vector.z];
  }

  private surfaceForCollider(handle: number): GameEvent['surface'] {
    return this.staticColliderPrimitives.get(handle)?.surface;
  }

  private traversalForCollider(handle: number): TraversalFlags | undefined {
    return this.staticColliderPrimitives.get(handle)?.traversal;
  }

  private actionProgress(): number {
    if (!this.player) return 0;
    const weapon = this.player.weapons[this.player.activeSlot].stats;
    if (this.player.action === 'reloading') return clamp(1 - this.player.reloadTimer / weapon.reloadSeconds, 0, 1);
    if (this.player.action === 'melee') return clamp(1 - this.player.meleeTimer / this.player.meleeDuration, 0, 1);
    if (this.player.action === 'firing') return clamp(1 - this.player.fireCooldown / (60 / weapon.roundsPerMinute), 0, 1);
    return 0;
  }

  private startReload(events: GameEvent[]): void {
    this.player.action = 'reloading';
    this.player.reloadTimer = this.player.weapons[this.player.activeSlot].stats.reloadSeconds;
    events.push(this.event('reloadStart', this.cameraPosition(), undefined, undefined, {
      sourceEntityId: this.player.id,
    }));
  }

  private event(
    kind: GameEvent['kind'],
    position?: Vec3 | RAPIER.Vector,
    entityId?: number,
    value?: number,
    details: Omit<Partial<GameEvent>, 'id' | 'tick' | 'kind' | 'position' | 'entityId' | 'value'> = {},
  ): GameEvent {
    let tuple: Vec3 | undefined;
    if (position) {
      tuple = 'x' in position
        ? [position.x, position.y, position.z]
        : [position[0], position[1], position[2]];
    }
    return { id: this.nextEventId++, tick: this.tick, kind, position: tuple, entityId, value, ...details };
  }

  private disposeWorld(): void {
    const playerController = this.playerController;
    const botController = this.botController;
    const world = this.world;
    this.playerController = undefined!;
    this.botController = undefined!;
    this.world = undefined!;
    playerController?.free();
    botController?.free();
    world?.free();
  }

  private syncEncounterGates(): void {
    if (!this.level) return;
    // Gate membership only changes here, so the snapshot can reuse the list.
    this.openGateIds = [...new Set([
      ...this.completedEncounters,
      ...this.level.primitives
        .filter((primitive) => primitive.gateForEncounterId && this.completedEncounters.has(primitive.gateForEncounterId))
        .map((primitive) => primitive.id),
    ])];
    for (const primitive of this.level.primitives) {
      if (!primitive.gateForEncounterId) continue;
      const body = this.staticBodiesByPrimitiveId.get(primitive.id);
      body?.setEnabled(!this.completedEncounters.has(primitive.gateForEncounterId));
    }
  }

  private snapPlayerToGroundAtSpawn(): void {
    const position = this.player.body.translation();
    const hit = this.world.castRay(
      new RAPIER.Ray(position, { x: 0, y: -1, z: 0 }),
      1.22,
      true,
      undefined,
      undefined,
      this.player.collider,
      this.player.body,
      (collider) => this.staticColliderIds.has(collider.handle),
    );
    if (!hit || hit.timeOfImpact < 0.82 || hit.timeOfImpact > 1.22) return;
    const y = position.y - (hit.timeOfImpact - 0.92);
    this.player.body.setTranslation({ x: position.x, y, z: position.z }, true);
    this.player.body.setNextKinematicTranslation({ x: position.x, y, z: position.z });
    this.player.grounded = true;
    this.player.locomotion = 'grounded';
  }

  private releaseOpenedGateGrapple(events: GameEvent[]): void {
    const handle = this.player.grappleColliderHandle;
    if (handle === null) return;
    const primitiveId = this.staticColliderIds.get(handle);
    const primitive = this.level.primitives.find((candidate) => candidate.id === primitiveId);
    if (primitive?.gateForEncounterId && this.completedEncounters.has(primitive.gateForEncounterId)) {
      this.releaseGrapple(events, false);
    }
  }
}

function createWeaponSlot(build: WeaponBuild): WeaponSlotState {
  const stats = resolveWeaponStats(build);
  return { build, stats, ammo: stats.magazineSize, reserveAmmo: stats.reserveAmmo };
}

/** Spawn kinds name the bot they place; the profile table is keyed by the bot. */
function botProfileKind(kind: SpawnDefinition['kind']): BotProfile['kind'] {
  if (kind === 'bot-aggressive') return 'aggressive';
  if (kind === 'bot-bulwark') return 'bulwark';
  return 'ranged';
}

function forwardFromYaw(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

function directionFromLook(yaw: number, pitch: number): RAPIER.Vector {
  const cosPitch = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cosPitch, y: Math.sin(pitch), z: -Math.cos(yaw) * cosPitch };
}

function wrapAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

/**
 * Scatters a direction inside a cone of the given half-angle. The offset is built
 * in the basis around `direction`, so the pattern is a disc of the same angular
 * size wherever the shooter is looking; perturbing world components instead makes
 * the spread a box whose size depends on the view axis. `sqrt` on the radius keeps
 * the samples uniform over the disc rather than bunched at the centre.
 */
function coneDirection(direction: RAPIER.Vector, halfAngle: number, random: SeededRandom): RAPIER.Vector {
  if (halfAngle <= 0) return direction;
  const horizontal = Math.hypot(direction.x, direction.z);
  // Looking straight up or down leaves no horizontal component to derive a right
  // vector from, so fall back to world X.
  const right = horizontal > 1e-4
    ? { x: -direction.z / horizontal, y: 0, z: direction.x / horizontal }
    : { x: 1, y: 0, z: 0 };
  const up = {
    x: direction.y * right.z - direction.z * right.y,
    y: direction.z * right.x - direction.x * right.z,
    z: direction.x * right.y - direction.y * right.x,
  };
  const angle = random.next() * Math.PI * 2;
  const radius = Math.sqrt(random.next()) * halfAngle;
  const offsetRight = Math.cos(angle) * radius;
  const offsetUp = Math.sin(angle) * radius;
  return normalize3({
    x: direction.x + right.x * offsetRight + up.x * offsetUp,
    y: direction.y + right.y * offsetRight + up.y * offsetUp,
    z: direction.z + right.z * offsetRight + up.z * offsetUp,
  });
}

function normalize3(value: RAPIER.Vector): RAPIER.Vector {
  const length = Math.hypot(value.x, value.y, value.z) || 1;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function eulerQuaternion(x: number, y: number, z: number): RAPIER.Rotation {
  const cx = Math.cos(x / 2); const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2); const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2); const sz = Math.sin(z / 2);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}
