export type Vec3 = readonly [number, number, number];

export const Action = {
  Forward: 1 << 0,
  Back: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Jump: 1 << 4,
  Sprint: 1 << 5,
  Crouch: 1 << 6,
  Dash: 1 << 7,
  Fire: 1 << 8,
  Ads: 1 << 9,
  Reload: 1 << 10,
  Melee: 1 << 11,
  Grapple: 1 << 12,
  WeaponPrimary: 1 << 13,
  WeaponSecondary: 1 << 14,
  WeaponSwap: 1 << 15,
  GrapplePull: 1 << 16,
  /**
   * The blade. This is the primary verb: `Fire` is the sidearm now, and it moved to
   * the right mouse button to make room for it. `Melee` is the heavy on the same
   * blade -- slower, wider, and the only swing that sweeps more than one target.
   */
  Slash: 1 << 17,
} as const;

export interface InputFrame {
  tick: number;
  held: number;
  pressed: number;
  released: number;
  look: readonly [number, number];
}

export interface AgentCommand {
  move: readonly [number, number];
  lookYaw: number;
  lookPitch: number;
  held: number;
  pressed: number;
}

export type LocomotionState =
  | 'grounded'
  | 'airborne'
  | 'sliding'
  | 'crouching'
  | 'wall-running-left'
  | 'wall-running-right'
  | 'vaulting'
  | 'mantling'
  | 'dashing'
  | 'grappling'
  | 'dead';

export type ActionState = 'neutral' | 'firing' | 'reloading' | 'melee' | 'stunned';

export interface EntitySnapshot {
  id: number;
  kind: 'player' | 'bot';
  position: Vec3;
  velocity: Vec3;
  rotationY: number;
  grounded: boolean;
  aimPitch: number;
  health: number;
  /**
   * What this entity's health is measured against. Published because a daily
   * modifier scales bot health, so presentation cannot derive the bar's maximum
   * from an authored profile without silently disagreeing with the simulation.
   */
  maxHealth: number;
  profile?: BotProfile['kind'];
}

export interface SimulationSnapshot {
  tick: number;
  elapsedSeconds: number;
  entities: readonly EntitySnapshot[];
  camera: {
    position: Vec3;
    yaw: number;
    pitch: number;
    fov: number;
  };
  player: {
    health: number;
    ammo: number;
    reserveAmmo: number;
    /** Magazine capacity of the active weapon, so the HUD can size its readout. */
    magazineSize: number;
    weapons: {
      activeSlot: number;
      ready: boolean;
      /**
       * Which weapon is actually in the player's hands right now.
       *
       * Decided in the simulation, and that is the whole point of it. The viewmodel used
       * to own a private timer that chose which model to draw, and the HUD had no way to
       * ask it -- so the ammo corner read `CARBINE 30/120` while a blade was on screen
       * and in the player's hands. Two timers in two layers is how a play frame ends up
       * lying about the thing the player is holding. One field, read by both.
       */
      inHand: 'blade' | 'gun';
      /** The blade style carried into this run, so presentation can name what is held. */
      blade: BladeStyleId;
      slots: readonly {
        name: string;
        chassisId: WeaponChassisId;
        /** Fitted part ids, so the renderer can shape the viewmodel to the build. */
        parts: Partial<Record<WeaponPartSlot, string>>;
        ammo: number;
        reserveAmmo: number;
      }[];
    };
    locomotion: LocomotionState;
    action: ActionState;
    adsProgress: number;
    actionProgress: number;
    /** Accumulated spread bloom as a fraction of its ceiling, for crosshair feedback. */
    spreadBloom: number;
    /** 0 standing, 1 fully crouched. Drives the eye height and the collider. */
    stance: number;
    speed: number;
    airCharge: number;
    grapple: {
      active: boolean;
      anchor: Vec3 | null;
      ropeLength: number;
      cooldown: number;
      available: boolean;
      /**
       * Where the hook would land right now, so the player can see it before
       * committing. `traversal.grapple` already said which surfaces are hookable and
       * nothing ever surfaced it, leaving the signature mechanic with no affordance.
       */
      aim: { point: Vec3; valid: boolean } | null;
    };
    dashAvailable: boolean;
    /**
     * The defensive verb. A dash arms invulnerability frames, and a telegraphed shot
     * that would have connected inside them is a perfect dodge instead of damage.
     */
    dodge: {
      /** True while the frames are live, so nothing incoming can land. */
      invulnerable: boolean;
      /** Whether the next dash would arm them. */
      ready: boolean;
      /** Seconds until it would, so presentation can draw the wait. */
      cooldown: number;
    };
    jumpCancelAvailable: boolean;
    wallJumpAvailable: boolean;
    /** Entity id the ADS assist is tracking, or null when nothing is locked. */
    lockedTargetId: number | null;
    score: number;
    /**
     * The flow chain. Traversal tech and kills add links, each link raises the
     * multiplier every award is scaled by, and the chain lapses if nothing extends
     * it inside the window.
     */
    combo: {
      links: number;
      multiplier: number;
      /** Fraction of the link window still open, so the HUD can draw urgency. */
      window: number;
      /** Longest chain reached this run. Survives restores and gates the top rank. */
      peakLinks: number;
    };
    /** Deaths so far this run. Survives checkpoint restores; gates the run's rank. */
    deaths: number;
    /** True while the player is down and waiting to be sent back to the checkpoint. */
    awaitingRespawn: boolean;
  };
  /** Checkpoint times reached this run, in the order they were cleared. */
  splits: readonly RunSplit[];
  objective: string;
  /**
   * Which wave of the current encounter is live, and how many it has. Both 0 when the
   * player is between rooms, so presentation can tell "no fight" from "first of three".
   */
  wave: { current: number; total: number };
  completed: boolean;
  openGateIds: readonly string[];
}

export interface GameEvent {
  id: number;
  tick: number;
  kind: 'shot' | 'impact' | 'hit' | 'kill' | 'melee' | 'checkpoint' | 'death' | 'complete' | 'grappleAttach' | 'grapplePull' | 'grappleRelease' | 'grappleFail' | 'reloadStart' | 'reloadComplete' | 'enemyTelegraph' | 'enemyAttack' | 'gateOpen' | 'dryFire' | 'respawn' | 'split' | 'comboLink' | 'comboBreak' | 'dodge' | 'wave';
  position?: Vec3;
  /**
   * Start of the segment an event describes, when `position` is its end. Set on
   * shots so presentation can draw the trace without guessing an origin.
   */
  origin?: Vec3;
  normal?: Vec3;
  entityId?: number;
  sourceEntityId?: number;
  targetEntityId?: number;
  value?: number;
  surface?: SurfaceTag;
  headshot?: boolean;
  /** Set on a hit a shield arc absorbed, so the confirmation can say so. */
  deflected?: boolean;
  /**
   * Set on a `melee` event a heavy swing produced. The two swings are one event kind
   * with one animation state, so this is what lets the mix give the heavy its own
   * weight without the presentation layer having to infer it from the damage.
   */
  heavy?: boolean;
  gateId?: string;
}

export interface SimulationOutput {
  snapshot: SimulationSnapshot;
  events: readonly GameEvent[];
}

export interface TransformData {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export type SurfaceTag = 'default' | 'wall-run' | 'vault' | 'mantle' | 'no-traverse';

export interface LevelPrimitive {
  id: string;
  kind: 'box' | 'ramp';
  transform: TransformData;
  color: string;
  collision: boolean;
  surface: SurfaceTag;
  gateForEncounterId?: string;
}

/** Explicit traversal behavior for V2 collision geometry. */
export interface TraversalFlags {
  wallRun: boolean;
  vault: boolean;
  mantle: boolean;
  grapple: boolean;
}

/** Navigation metadata is intentionally separate from render materials. */
export interface NavigationFlags {
  includeInBake: boolean;
  walkable: boolean;
}

/**
 * V2 retains the V1 primitive fields so existing simulation and editor code can
 * consume collision proxies while the visual asset pipeline migrates separately.
 */
export interface CollisionPrimitiveV2 extends LevelPrimitive {
  traversal: TraversalFlags;
  nav: NavigationFlags;
}

export type CollisionPrimitive = CollisionPrimitiveV2;

export interface VisualInstance {
  id: string;
  assetId: string;
  transform: TransformData;
  materialVariantId?: string;
  castShadow: boolean;
  receiveShadow: boolean;
  collisionAlignmentId?: string;
  gateVisibilityBindingId?: string;
}

export interface LightInstance {
  id: string;
  kind: 'point' | 'spot';
  transform: TransformData;
  color: string;
  intensity: number;
  range: number;
  coneAngle?: number;
  penumbra?: number;
  castShadow: boolean;
  gateVisibilityBindingId?: string;
}

/** @deprecated Use `LightInstance`. */
export type LightDefinition = LightInstance;

export interface AssetCatalogEntry {
  id: string;
  uri: string;
  kind: 'glb';
  defaultScale?: number;
  tags?: readonly string[];
}

export interface AssetCatalog {
  version: string;
  assets: readonly AssetCatalogEntry[];
}

export interface SpawnDefinition {
  id: string;
  kind: 'player' | 'bot-ranged' | 'bot-aggressive' | 'bot-bulwark';
  position: Vec3;
  rotationY: number;
  encounterId?: string;
  /**
   * Which wave of its encounter this hostile belongs to. Omitted means the first.
   *
   * A room with waves is how the genre gets volume without putting twelve bodies on
   * screen at once: wave `n + 1` activates on the tick the last of wave `n` dies, at its
   * authored spawn, so an arena keeps producing pressure while the concurrent count
   * stays inside the frame budget. The encounter is only cleared when every wave is.
   */
  wave?: number;
}

export interface EncounterDefinition {
  id: string;
  label: string;
  checkpoint: Vec3;
  requiredBotIds: readonly string[];
}

export interface OffMeshLink {
  id: string;
  start: Vec3;
  end: Vec3;
  bidirectional: boolean;
  action: 'jump' | 'vault' | 'drop';
}

export interface LegacyLevelDocumentV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  units: 'meters';
  primitives: LevelPrimitive[];
  spawns: SpawnDefinition[];
  encounters: EncounterDefinition[];
  offMeshLinks: OffMeshLink[];
  exit: Vec3;
}

export interface LevelDocumentV2 {
  schemaVersion: 2;
  id: string;
  name: string;
  units: 'meters';
  collision: CollisionPrimitiveV2[];
  visuals: VisualInstance[];
  lights: LightInstance[];
  environmentPresetId: string;
  assetCatalogVersion: string;
  /** @deprecated Compatibility alias. Always references `collision` in normalized documents. */
  primitives: CollisionPrimitiveV2[];
  spawns: SpawnDefinition[];
  encounters: EncounterDefinition[];
  offMeshLinks: OffMeshLink[];
  exit: Vec3;
}

export type LevelDocument = LegacyLevelDocumentV1 | LevelDocumentV2;

/** @deprecated Use `LevelDocument` or `LevelDocumentV2`. */
export type LevelDocumentV1 = LevelDocument;

export interface RuntimeLevelMetadata {
  bakedAt: string;
  navMeshData?: Uint8Array;
}

export type RuntimeLevelV2 = LevelDocumentV2 & RuntimeLevelMetadata;

export type LegacyRuntimeLevelV1 = LegacyLevelDocumentV1 & RuntimeLevelMetadata;

/** @deprecated Runtime documents are normalized to V2 before use. */
export type RuntimeLevelV1 = RuntimeLevelV2;

export interface MovementProfile {
  walkSpeed: number;
  sprintSpeed: number;
  groundAcceleration: number;
  airAcceleration: number;
  groundFriction: number;
  gravity: number;
  jumpSpeed: number;
  coyoteSeconds: number;
  jumpBufferSeconds: number;
  slideSeconds: number;
  slideBoost: number;
  /** Downhill acceleration while sliding, scaled by the ground normal. */
  slideSlopeAcceleration: number;
  /** Speed cap while crouched. */
  crouchSpeed: number;
  dashSpeed: number;
  dashSeconds: number;
  /** Window in which a second jump press is read as a dash instead of a jump. */
  dashDoubleTapSeconds: number;
  wallRunGravity: number;
  wallJumpHorizontal: number;
  wallJumpVertical: number;
  grappleRange: number;
  /**
   * Closest an anchor may be and still attach. Must stay above
   * `grappleArrivalRadius`, or a hook would release on the tick it lands.
   */
  grappleMinimumRange: number;
  /** Constant speed the player travels along the line while the hook is held. */
  grapplePullSpeed: number;
  /** Extra travel speed added by each pull press, kept until the hook releases. */
  grapplePullImpulse: number;
  /** Minimum time between pulls, so a held key cannot fire every tick. */
  grapplePullCooldown: number;
  /** Ceiling on travel speed, so stacked pulls cannot run away. */
  grappleMaxSpeed: number;
  /** Distance from the anchor at which the tether releases. */
  grappleArrivalRadius: number;
  grappleCooldown: number;
  grappleReleaseBoost: number;
}

export interface AimAssistProfile {
  /** Maximum distance at which a target can be acquired or held. */
  range: number;
  /** Cosine of the half-angle in which a new target may be acquired. */
  acquireCosine: number;
  /** Cosine of the wider half-angle that keeps an acquired target. */
  holdCosine: number;
  /**
   * Fraction the player's own look input is scaled to when a target is dead centre.
   * This is the assist: it makes a target easier to stay on without ever moving the
   * crosshair for the player.
   */
  slowdownScale: number;
  /**
   * Ceiling, in radians per second, on how fast the assist may itself turn the view.
   * A bounded rate can settle a shot the player has already lined up; it cannot cross
   * the screen and acquire one for them, which is what an exponential blend did.
   */
  maxTurnRate: number;
  /** Vertical offset from the target origin toward centre mass. */
  aimHeight: number;
}

/**
 * Resolved stat block a weapon build produces, and the only shape the simulation reads.
 *
 * Melee is not in here. It used to be, as `meleeDamage` and `meleeRange` repeated
 * identically on all four chassis, because melee belongs to the operator rather than
 * to the gun. Now that the blade is the primary verb it is tuned once, in
 * `content/config.ts`, and a gun build cannot change it.
 */
export interface WeaponDefinition {
  magazineSize: number;
  reserveAmmo: number;
  roundsPerMinute: number;
  reloadSeconds: number;
  damage: number;
  headshotMultiplier: number;
  range: number;
  hipSpread: number;
  adsSpread: number;
  /** Projectiles fired per shot. Above one makes the shot a spread pattern. */
  pellets: number;
  /** Degrees of field of view removed while aiming down sights. */
  adsZoom: number;
  /** Upward kick applied to the view per shot, in radians. */
  recoilPitch: number;
  /** Bound on the horizontal kick per shot, in radians. Direction is seeded. */
  recoilYaw: number;
  /** Radians per second the view is handed back once firing stops. */
  recoilRecovery: number;
  /** Spread multiplier added per shot. */
  bloomPerShot: number;
  /** Ceiling on accumulated bloom. */
  bloomMax: number;
  /** Bloom shed per second. */
  bloomRecovery: number;
}

export type WeaponChassisId = 'carbine' | 'smg' | 'shotgun' | 'dmr';
export type WeaponPartSlot = 'optic' | 'barrel' | 'magazine' | 'grip' | 'stock';

export interface WeaponChassisDefinition {
  id: WeaponChassisId;
  label: string;
  description: string;
  base: WeaponDefinition;
}

/** Every modifier is a multiplier applied to the chassis base stat. */
export type WeaponPartModifiers = Partial<Record<
  'damage' | 'roundsPerMinute' | 'reloadSeconds' | 'range' | 'hipSpread' | 'adsSpread' | 'magazineSize' | 'reserveAmmo' | 'headshotMultiplier' | 'adsZoom'
  | 'recoilPitch' | 'recoilYaw' | 'recoilRecovery' | 'bloomPerShot',
  number
>>;

export interface WeaponPartDefinition {
  id: string;
  slot: WeaponPartSlot;
  label: string;
  description: string;
  /** Restricts the part to specific chassis. Omitted means it fits everything. */
  chassis?: readonly WeaponChassisId[];
  modifiers: WeaponPartModifiers;
}

export interface WeaponBuild {
  id: string;
  name: string;
  chassisId: WeaponChassisId;
  parts: Partial<Record<WeaponPartSlot, string>>;
}

/**
 * The blade the player carries, chosen rather than assembled.
 *
 * Guns are a stat game -- four chassis, five slots, multipliers -- and that is the right
 * shape for a secondary. The blade is the primary verb, so its reward layer is a *rules*
 * game instead: a style changes how the chain behaves, not how much damage a number says.
 * That is also why there are no part slots here. Duplicating the parts machinery for a
 * second weapon would have produced two stat games and no reason to prefer either.
 */
export type BladeStyleId = 'tempo' | 'cleave' | 'riposte';

/** What a style does to the flow chain. Every field is relative to `comboScoring`. */
export interface BladeChainBehaviour {
  /** Links a kill pays. The base is one, and a headshot already doubles it. */
  killLinks: number;
  /** Links a perfect dodge pays. */
  dodgeLinks: number;
  /** Added to the seconds a chain survives with nothing extending it. */
  windowBonusSeconds: number;
  /** Added to the multiplier every link is worth. */
  linkStepBonus: number;
}

/** One swing's envelope. Both swings share the shape; only the numbers differ. */
export interface BladeSwingProfile {
  seconds: number;
  range: number;
  arcCosine: number;
  damage: number;
}

export interface BladeStyleDefinition {
  id: BladeStyleId;
  label: string;
  /** One line, in the register the bench already writes in. */
  description: string;
  /** What the style is *for*, said in terms of the chain rather than the stats. */
  chainNote: string;
  light: BladeSwingProfile;
  heavy: BladeSwingProfile & {
    /** Least a shield arc may scale the heavy to. */
    shieldFloor: number;
  };
  chain: BladeChainBehaviour;
  /** Colour the generated blade's lit edge takes. Stays inside the player's yellow. */
  accent: string;
}

export interface BotProfile {
  kind: 'ranged' | 'aggressive' | 'bulwark';
  health: number;
  moveSpeed: number;
  preferredRange: number;
  fireInterval: number;
  damage: number;
  /**
   * Telegraph before the shot lands. The bot commits to firing, announces it,
   * and only then resolves the trace, so breaking line of sight during the
   * window defeats the shot.
   */
  windupSeconds: number;
  /** Aim error in radians at a standstill. */
  baseSpread: number;
  /**
   * Extra aim error per metre per second of player speed. Moving fast is what
   * makes a bot miss, so the movement kit is also the defence.
   */
  spreadPerSpeed: number;
  /**
   * How fast the bot can bring its facing round, in radians a second. Omitted means
   * it simply faces the player, which is what a bot with nothing to protect and
   * nothing to aim does.
   */
  turnRate?: number;
  /**
   * A plate carried on the bot's front. Damage arriving inside the arc is scaled
   * down, so the counter is to get around it rather than to out-shoot it -- which
   * is a question the movement kit answers and a bigger health pool would not.
   */
  shield?: {
    /** Cosine of the half-angle the plate covers, measured from the bot's facing. */
    arcCosine: number;
    /** What the plate scales incoming damage to. */
    damageScale: number;
  };
  /**
   * Cosine of the half-angle the player has to be inside for the bot to commit a
   * shot. Omitted means it can fire whichever way it happens to be pointing.
   */
  fireArcCosine?: number;
}

/**
 * Tech that can extend a flow chain. Every kind links at most once per chain; only
 * `kill` repeats, and that is bounded by the number of hostiles.
 *
 * The two blade kinds are the point of the list being this long. A light and a heavy
 * are different link kinds, so the no-repeat rule does the work for free: mashing one
 * attack pays exactly one link however many times it lands, and a chain grows by
 * reaching for the *other* swing, the dash, the dodge or the movement kit. That is the
 * anti-mashing rule this genre is built on, and it was already in the simulation --
 * melee simply had nothing in the list to spend.
 */
export type ComboLinkKind =
  | 'dash' | 'wall-run' | 'wall-jump' | 'vault' | 'hook' | 'pull'
  | 'slash' | 'heavy' | 'dodge' | 'kill';

/** Bounded, multiplicative tweaks a modifier may apply to every bot profile. */
export type BotProfileScaling = Partial<Record<
  'health' | 'moveSpeed' | 'preferredRange' | 'fireInterval' | 'damage' | 'windupSeconds' | 'baseSpread',
  number
>>;

export interface RunModifier {
  id: string;
  label: string;
  description: string;
  /** Chassis this modifier pays a bonus for carrying. */
  favouredChassis: readonly WeaponChassisId[];
  /** Added to the multiplier on score earned with a favoured chassis. */
  chassisBonus: number;
  /** Added to the multiplier on chain link payouts. */
  linkBonus: number;
  /** Added to the multiplier on the whole run's score. */
  runBonus?: number;
  enemy: BotProfileScaling;
}

export type RunRank = 'S' | 'A' | 'B' | 'C';

/** Time the player reached a named checkpoint, measured from the run's start. */
export interface RunSplit {
  encounterId: string;
  label: string;
  seconds: number;
}

/**
 * One completed attempt, kept whole. The previous save stored best time, best score
 * and rank as three independent fields, so the record card could describe three
 * different runs at once.
 */
/**
 * Recorded path of a run, replayed as a ghost the player races.
 *
 * This stores the *positions* the run reached rather than the input tape that
 * produced them. Re-simulating a tape would need a second physics world every frame
 * and would only stay faithful while nothing else changed: `updateLook` scales raw
 * mouse deltas by `settings.sensitivity`, and the loadout decides when bots die,
 * which decides when gate colliders disable, which changes where the player can go.
 * A path is smaller, costs no simulation, and cannot silently desync -- and a ghost
 * only ever needs to show where the record was at a given moment.
 */
export interface GhostTrack {
  /** Level the path was recorded on. A path from another route is not replayed. */
  levelId: string;
  /** Seconds of run clock between samples. */
  intervalSeconds: number;
  /** Flat x, y, z triples in centimetres, kept integral so the payload stays compact. */
  samples: readonly number[];
}

export interface RunRecord {
  timeSeconds: number;
  score: number;
  rank: RunRank;
  deaths: number;
  /** Longest flow chain the run reached. */
  peakCombo: number;
  splits: readonly RunSplit[];
  /** Absent when the run was too long to store a path for. */
  ghost?: GhostTrack;
  /** Id of the daily modifier the run was set under, when there was one. */
  modifierId?: string;
}

export interface SaveSettingsV1 {
  sensitivity: number;
  fov: number;
  cameraRoll: number;
  headBob: number;
  shake: number;
  renderScale: number;
  debug: boolean;
  reducedMotion: boolean;
}

export type GraphicsQuality = 'auto' | 'low' | 'medium' | 'high';

export interface SaveSettingsV2 extends SaveSettingsV1 {
  graphicsQuality: GraphicsQuality;
  dynamicResolution: boolean;
}

export interface SaveSettingsV3 extends SaveSettingsV2 {
  /**
   * Output level of the whole mix, 0 to 1, applied as a gain after the bus the duck
   * automates. Added because the mix stopped being a set of transients: with a held
   * floor under every room and a movement layer that opens with speed, there is now
   * something sounding at all times and no way to turn it down. Zero is silence.
   */
  volume: number;
}

export interface LegacySaveDataV1 {
  schemaVersion: 1;
  settings: SaveSettingsV1;
  bestTimeSeconds: number | null;
  bestScore: number;
  rank: string | null;
}

export interface SaveDataV2 {
  schemaVersion: 2;
  settings: SaveSettingsV2;
  bestTimeSeconds: number | null;
  bestScore: number;
  rank: string | null;
}

export interface SaveDataV3 {
  schemaVersion: 3;
  settings: SaveSettingsV2;
  bestTimeSeconds: number | null;
  bestScore: number;
  rank: string | null;
  /** Every weapon build the player has assembled. */
  armory: WeaponBuild[];
  /** Ids of the two builds carried into a run, in slot order. */
  loadout: readonly [string, string];
}

export interface SaveDataV4 {
  schemaVersion: 4;
  settings: SaveSettingsV2;
  /** Best attempt by score. Every stat on it comes from that one run. */
  bestRun: RunRecord | null;
  /** Fastest clear, which may well be a different attempt, so it is labelled apart. */
  bestTimeSeconds: number | null;
  /** Every weapon build the player has assembled. */
  armory: WeaponBuild[];
  /** Ids of the two builds carried into a run, in slot order. */
  loadout: readonly [string, string];
}

export interface SaveDataV5 {
  schemaVersion: 5;
  settings: SaveSettingsV2;
  /** Best attempt by score. Every stat on it comes from that one run. */
  bestRun: RunRecord | null;
  /** Fastest clear, which may well be a different attempt, so it is labelled apart. */
  bestTimeSeconds: number | null;
  /** Every weapon build the player has assembled. */
  armory: WeaponBuild[];
  /** Ids of the two builds carried into a run, in slot order. */
  loadout: readonly [string, string];
  /**
   * The blade style carried into a run. Added in V5, because the blade became the
   * primary verb and the thing a player chooses about it is how their chain behaves.
   */
  blade: BladeStyleId;
}

export interface SaveDataV6 {
  schemaVersion: 6;
  /** V6 is V5 plus `volume`, which is the first setting the mix itself reads. */
  settings: SaveSettingsV3;
  /** Best attempt by score. Every stat on it comes from that one run. */
  bestRun: RunRecord | null;
  /** Fastest clear, which may well be a different attempt, so it is labelled apart. */
  bestTimeSeconds: number | null;
  /** Every weapon build the player has assembled. */
  armory: WeaponBuild[];
  /** Ids of the two builds carried into a run, in slot order. */
  loadout: readonly [string, string];
  /** The blade style carried into a run. */
  blade: BladeStyleId;
}

export type SaveData = LegacySaveDataV1 | SaveDataV2 | SaveDataV3 | SaveDataV4 | SaveDataV5 | SaveDataV6;

/** @deprecated Compatibility alias for consumers that still use the V1 name. */
export type SaveDataV1 = SaveData;

export interface CheckpointState {
  position: Vec3;
  health: number;
  /** Magazine and reserve counts per weapon slot. */
  ammo: readonly number[];
  reserveAmmo: readonly number[];
  activeSlot: number;
  score: number;
  completedEncounterIds: readonly string[];
  defeatedBotIds: readonly number[];
}

export interface GameSimulation {
  loadLevel(level: RuntimeLevelV1): Promise<void>;
  step(input: InputFrame, dt: number): SimulationOutput;
  captureCheckpoint(): CheckpointState;
  restoreCheckpoint(): void;
  suspend(): GameEvent[];
  dispose(): void;
}
