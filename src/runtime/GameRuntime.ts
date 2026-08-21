import type { BladeStyleId, BotProfile, GameEvent, GhostTrack, RunModifier, RuntimeLevelV1, SaveSettingsV3, SimulationSnapshot, Vec3, WeaponBuild } from '../contracts';
import { AudioManager } from '../audio/AudioManager';
import { bladeStyle } from '../content/blades';
import { chainEarnsFlourish } from '../content/config';
import { InputController } from '../input/InputController';
import { GameRenderer, type RenderStats } from '../render/GameRenderer';
import { FlowSimulation } from '../simulation/FlowSimulation';
import { GhostPlayback, GhostRecorder } from './GhostRecorder';

const STEP_SECONDS = 1 / 60;
const MAX_STEPS = 5;
/** Matches `damage-rise` in the stylesheet, so a number completes its float. */
const HIT_LIFETIME_MS = 780;
/**
 * Hits on one target inside this window merge into the number already on screen.
 * A 1020 RPM weapon would otherwise stack seventeen numbers a second on one enemy.
 */
const HIT_MERGE_MS = 260;
/** How long a directional damage wedge stays up. */
const DAMAGE_LIFETIME_MS = 900;
const MAX_ACTIVE_HITS = 24;
const MAX_ACTIVE_DAMAGE = 8;
/**
 * How long the chain flourish stays mounted. Long enough for its animation to run
 * and short enough that it is gone before the player has to read the frame again --
 * it fires while they are moving, which is the whole reason it is not persistent.
 */
const OVATION_LIFETIME_MS = 900;
/**
 * How long the perfect-dodge confirmation stays mounted. Shorter than the chain
 * flourish because it fires at the exact moment the player is being shot at, and
 * anything that outlasts the threat is covering the frame they need to read.
 */
const DODGE_LIFETIME_MS = 620;

/** A confirmed hit on an enemy, already projected to canvas pixels for the HUD. */
export interface HitFeedback {
  id: number;
  screen: readonly [number, number];
  amount: number;
  headshot: boolean;
  kill: boolean;
  /** The shot landed on a shield arc, so most of it was absorbed. */
  deflected: boolean;
}

/** Incoming damage, as a bearing in radians relative to where the player looks. */
export interface DamageFeedback {
  id: number;
  bearing: number;
  amount: number;
}

/**
 * Retained in world space so the number can be re-projected every frame and stay
 * pinned to the enemy while the player keeps moving.
 */
interface ActiveHit {
  id: number;
  targetId: number;
  world: Vec3;
  amount: number;
  headshot: boolean;
  kill: boolean;
  deflected: boolean;
  bornAt: number;
  expiresAt: number;
}

interface ActiveDamage extends DamageFeedback {
  expiresAt: number;
}

/**
 * A chain that has just crossed a flourish threshold. Transient by construction:
 * one entry with its own short expiry, so the HUD has nothing persistent to draw.
 */
export interface ChainOvation {
  id: number;
  links: number;
}

/**
 * A round that was going to land and did not. Transient by construction, like the
 * chain flourish: one entry with its own short expiry and nothing persistent.
 */
export interface DodgeMark {
  id: number;
  /** Damage the dodge refused, so the confirmation can say what it was worth. */
  refused: number;
}

/** How the run stands against the record path, for the HUD. */
export interface GhostStanding {
  /** Negative means ahead of the record, positive means behind it. */
  deltaSeconds: number | null;
  finished: boolean;
}

export interface RuntimeUpdate {
  snapshot: SimulationSnapshot;
  stats: RenderStats & { simulationMs: number; steps: number };
  hits: readonly HitFeedback[];
  damage: readonly DamageFeedback[];
  /** Null except in the brief window after the chain crosses a flourish threshold. */
  ovation: ChainOvation | null;
  /** Null except in the brief window after a telegraphed shot was dodged. */
  dodge: DodgeMark | null;
  /** Null when no record path exists for this route yet. */
  ghost: GhostStanding | null;
}

export class GameRuntime {
  private readonly simulation: FlowSimulation;
  private readonly renderer: GameRenderer;
  private readonly input: InputController;
  private readonly audio = new AudioManager();
  private animationFrame = 0;
  private tick = 0;
  private lastTime = performance.now();
  private accumulator = 0;
  private snapshot!: SimulationSnapshot;
  private pendingEvents: GameEvent[] = [];
  private activeHits: ActiveHit[] = [];
  private activeDamage: ActiveDamage[] = [];
  private activeOvation: (ChainOvation & { expiresAt: number }) | null = null;
  private activeDodge: (DodgeMark & { expiresAt: number }) | null = null;
  private running = false;
  private disposed = false;
  private lastUiUpdate = 0;
  private recorder: GhostRecorder | null = null;
  private playback: GhostPlayback | null = null;
  private readonly unsubscribeLock: () => void;
  /** Reused between frames. See `audioProfiles`. */
  private readonly profileRoster = new Map<number, BotProfile['kind']>();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onUpdate: (update: RuntimeUpdate) => void,
    private readonly onLockChange: (locked: boolean) => void,
    settings: SaveSettingsV3,
    loadout?: readonly WeaponBuild[],
    private readonly recordGhost?: GhostTrack,
    modifier: RunModifier | null = null,
    blade?: BladeStyleId,
  ) {
    this.simulation = new FlowSimulation(settings, loadout, modifier, blade);
    this.renderer = new GameRenderer(canvas, settings);
    // Set before the context exists: `AudioManager` holds both of these and applies them
    // when the first gesture builds the graph.
    this.audio.setVolume(settings.volume);
    // The blade is the primary verb and the three styles sounded identical. Set once,
    // because the style is chosen at the bench and cannot change inside a run.
    this.audio.setBladeStyle(blade);
    this.renderer.setBladeAccent(bladeStyle(blade).accent);
    this.input = new InputController(canvas);
    this.unsubscribeLock = this.input.onLockChange((locked) => {
      this.accumulator = 0;
      this.lastTime = performance.now();
      if (!locked) this.pendingEvents.push(...this.simulation.suspend());
      onLockChange(locked);
    });
  }

  updateSettings(settings: SaveSettingsV3): void {
    this.simulation.updateSettings(settings);
    this.renderer.updateSettings(settings);
    this.audio.setVolume(settings.volume);
  }

  async initialize(level: RuntimeLevelV1): Promise<void> {
    await Promise.all([
      this.simulation.loadLevel(level),
      this.renderer.loadLevel(level),
    ]);
    if (this.disposed) {
      this.simulation.dispose();
      return;
    }
    this.recorder = new GhostRecorder(level.id);
    this.playback = GhostPlayback.forLevel(this.recordGhost, level.id);
    const initial = this.simulation.step({ tick: 0, held: 0, pressed: 0, released: 0, look: [0, 0] }, STEP_SECONDS);
    this.snapshot = initial.snapshot;
    this.running = true;
    this.lastTime = performance.now();
    this.animationFrame = requestAnimationFrame(this.loop);
  }

  /**
   * What each live hostile is made of, for the mix.
   *
   * Rebuilt in place every frame rather than allocated: this runs at the display rate
   * alongside everything else in `loop`, and a fresh `Map` of twenty-eight entries per
   * frame is garbage for no reason. The mix needs it because a slash into a brawler, a
   * slash into a plate and a slash into a hunter are three different impacts and the
   * simulation is the only thing that knows which one happened.
   */
  private audioProfiles(): ReadonlyMap<number, BotProfile['kind']> {
    this.profileRoster.clear();
    for (const entity of this.snapshot.entities) {
      if (entity.kind === 'bot' && entity.profile) this.profileRoster.set(entity.id, entity.profile);
    }
    return this.profileRoster;
  }

  /** The path this run took, for storing alongside a new record. */
  ghostTrack(): GhostTrack | null {
    return this.recorder?.track() ?? null;
  }

  async startInput(): Promise<void> {
    await this.audio.resume();
    await this.input.requestLock();
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.animationFrame);
    this.unsubscribeLock();
    this.input.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    this.simulation.dispose();
  }

  private ghostStanding(): GhostStanding | null {
    const playback = this.playback;
    if (!playback) return null;
    const elapsed = this.snapshot.elapsedSeconds;
    return {
      deltaSeconds: playback.deltaSeconds(elapsed, this.snapshot.entities[0]?.position ?? [0, 0, 0]),
      finished: playback.finishedBy(elapsed),
    };
  }

  private playerId(): number | undefined {
    return this.snapshot?.entities[0]?.id;
  }

  /**
   * Feedback lives on its own clock rather than the 20 Hz UI throttle. Previously
   * the buffer was emptied on every push, so a damage number was unmounted about
   * 50 ms after it appeared and never finished the animation it asks for.
   */
  private collectFeedback(events: readonly GameEvent[], now: number): void {
    const playerId = this.playerId();
    const kills = new Set(events.filter((event) => event.kind === 'kill').map((event) => event.targetEntityId ?? event.entityId));
    for (const event of events) {
      if (event.kind === 'comboLink') {
        // The simulation already counts the chain; this only decides which lengths
        // are worth a flourish, and the thresholds live in `content/config.ts`.
        const links = Math.round(event.value ?? 0);
        if (chainEarnsFlourish(links)) this.activeOvation = { id: event.id, links, expiresAt: now + OVATION_LIFETIME_MS };
        continue;
      }
      if (event.kind === 'dodge') {
        this.activeDodge = { id: event.id, refused: Math.round(event.value ?? 0), expiresAt: now + DODGE_LIFETIME_MS };
        continue;
      }
      if (event.kind === 'enemyAttack') {
        // A miss still reports, with zero damage; only landed shots get a wedge.
        if ((event.value ?? 0) <= 0) continue;
        this.activeDamage.push({
          id: event.id,
          bearing: this.bearingTo(event.origin ?? event.position),
          amount: event.value ?? 0,
          expiresAt: now + DAMAGE_LIFETIME_MS,
        });
        continue;
      }
      if (event.kind !== 'hit' || !event.position) continue;
      const target = event.targetEntityId ?? event.entityId;
      if (target === undefined || target === playerId) continue;
      const amount = Math.round(event.value ?? 0);
      const kill = kills.has(target);
      // Merging keeps the DOM node, so the number climbs in place instead of
      // restarting its animation on every round that lands.
      const open = this.activeHits.find((hit) => hit.targetId === target && now - hit.bornAt < HIT_MERGE_MS);
      if (open) {
        open.amount += amount;
        open.headshot ||= event.headshot === true;
        open.kill ||= kill;
        // Latest round wins rather than sticking: the point of the marker is to say
        // whether the line the player is shooting *now* is being absorbed, so getting
        // round the plate mid-burst has to clear it.
        open.deflected = event.deflected === true;
        open.world = event.position;
        open.expiresAt = now + HIT_LIFETIME_MS;
        continue;
      }
      this.activeHits.push({
        id: event.id,
        targetId: target,
        world: event.position,
        amount,
        headshot: event.headshot === true,
        kill,
        deflected: event.deflected === true,
        bornAt: now,
        expiresAt: now + HIT_LIFETIME_MS,
      });
    }
    if (this.activeHits.length > MAX_ACTIVE_HITS) this.activeHits = this.activeHits.slice(-MAX_ACTIVE_HITS);
    if (this.activeDamage.length > MAX_ACTIVE_DAMAGE) this.activeDamage = this.activeDamage.slice(-MAX_ACTIVE_DAMAGE);
  }

  /**
   * Re-projects every live hit against the current camera, so numbers stay pinned
   * to the enemy that took them instead of freezing where the camera used to be.
   * Ones that leave the frame are simply not drawn this pass and may return.
   */
  private projectHits(now: number): readonly HitFeedback[] {
    this.activeHits = this.activeHits.filter((hit) => hit.expiresAt > now);
    const projected: HitFeedback[] = [];
    for (const hit of this.activeHits) {
      const screen = this.renderer.projectToScreen(hit.world);
      if (!screen) continue;
      projected.push({ id: hit.id, screen, amount: hit.amount, headshot: hit.headshot, kill: hit.kill, deflected: hit.deflected });
    }
    return projected;
  }

  private currentOvation(now: number): ChainOvation | null {
    if (this.activeOvation && this.activeOvation.expiresAt <= now) this.activeOvation = null;
    return this.activeOvation && { id: this.activeOvation.id, links: this.activeOvation.links };
  }

  private currentDodge(now: number): DodgeMark | null {
    if (this.activeDodge && this.activeDodge.expiresAt <= now) this.activeDodge = null;
    return this.activeDodge && { id: this.activeDodge.id, refused: this.activeDodge.refused };
  }

  private activeDamageWedges(now: number): readonly DamageFeedback[] {
    this.activeDamage = this.activeDamage.filter((entry) => entry.expiresAt > now);
    return this.activeDamage.map(({ id, bearing, amount }) => ({ id, bearing, amount }));
  }

  /**
   * Bearing of a world point relative to the view: 0 is dead ahead and positive is
   * to the player's right. Matches the simulation basis, where forward is
   * (-sin yaw, -cos yaw) and right is (cos yaw, -sin yaw).
   */
  private bearingTo(source: Vec3 | undefined): number {
    const camera = this.snapshot?.camera;
    if (!source || !camera) return 0;
    const dx = source[0] - camera.position[0];
    const dz = source[2] - camera.position[2];
    if (Math.hypot(dx, dz) < 0.001) return 0;
    const forward = -dx * Math.sin(camera.yaw) - dz * Math.cos(camera.yaw);
    const right = dx * Math.cos(camera.yaw) - dz * Math.sin(camera.yaw);
    return Math.atan2(right, forward);
  }

  private loop = (now: number): void => {
    if (!this.running) return;
    const elapsed = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    let steps = 0;
    let simulationMs = 0;

    if (this.input.isLocked() && !document.hidden && !this.snapshot.completed) {
      this.accumulator += elapsed;
      while (this.accumulator >= STEP_SECONDS && steps < MAX_STEPS) {
        const started = performance.now();
        this.tick += 1;
        const output = this.simulation.step(this.input.frame(this.tick), STEP_SECONDS);
        simulationMs += performance.now() - started;
        this.snapshot = output.snapshot;
        this.pendingEvents.push(...output.events);
        this.accumulator -= STEP_SECONDS;
        steps += 1;
        // Sampled per fixed step rather than per frame, so the recorded path does not
        // depend on the display rate that produced it.
        this.recorder?.record(this.snapshot.elapsedSeconds, this.snapshot.entities[0]?.position ?? [0, 0, 0]);
      }
      if (steps === MAX_STEPS && this.accumulator >= STEP_SECONDS) this.accumulator = 0;
    } else {
      this.accumulator = 0;
    }

    this.audio.consume(this.pendingEvents, {
      position: this.snapshot.camera.position,
      yaw: this.snapshot.camera.yaw,
      playerId: this.playerId() ?? 0,
      profiles: this.audioProfiles(),
    });
    // The continuous half of the mix, driven every frame rather than by events: the low
    // floor a live room sits on and the movement layer that opens with speed. Kept apart
    // from `consume` because that method's job is turning things that happened into
    // sounds, and this one is reporting a state.
    this.audio.sustain({
      speed: this.snapshot.player.speed,
      threat: this.snapshot.entities.reduce((total, entity) => total + (entity.kind === 'bot' ? 1 : 0), 0),
      down: this.snapshot.player.awaitingRespawn,
      // The style meter, driving the mix rather than being reported by it: the bed
      // climbs, a harmonic opens and the room gets wetter while a chain is live.
      chain: { links: this.snapshot.player.combo.links, window: this.snapshot.player.combo.window },
    });
    const ghostPosition = this.playback?.positionAt(this.snapshot.elapsedSeconds) ?? null;
    const stats = this.renderer.render(this.snapshot, this.pendingEvents, this.accumulator / STEP_SECONDS, ghostPosition);
    // Both of these read the camera, which is only current immediately after render.
    this.collectFeedback(this.pendingEvents, now);
    this.pendingEvents = [];
    if (now - this.lastUiUpdate > 50 || this.snapshot.completed) {
      this.onUpdate({
        snapshot: this.snapshot,
        stats: { ...stats, simulationMs, steps },
        hits: this.projectHits(now),
        damage: this.activeDamageWedges(now),
        ovation: this.currentOvation(now),
        dodge: this.currentDodge(now),
        ghost: this.ghostStanding(),
      });
      this.lastUiUpdate = now;
    }
    this.animationFrame = requestAnimationFrame(this.loop);
  };
}
