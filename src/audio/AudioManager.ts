import type { GameEvent, Vec3 } from '../contracts';

/**
 * What the run sounds like *between* events.
 *
 * Every cue in this mix is a transient, which left the low end existing only in bursts:
 * the bass arrived with a hit and left with it, and the duck -- the mix's punctuation --
 * had almost nothing to take away, because there was nothing sounding to duck. This is
 * the floor those two things were missing.
 */
export interface AudioSustainState {
  /** Player speed in metres a second. Opens the movement layer. */
  speed: number;
  /** Hostiles able to act. A live room weighs more than a corridor. */
  threat: number;
  /** True while the player is down, when the floor falls away entirely. */
  down: boolean;
}

/** Where the player is and which way they face, so threats can be placed in the mix. */
export interface AudioListenerState {
  position: Vec3;
  yaw: number;
  playerId: number;
}

interface Voice {
  frequency: number;
  duration: number;
  gain: number;
  type: OscillatorType;
  /** Ratio the pitch slides to across the duration. 1 holds it flat. */
  bend?: number;
  /**
   * Where the voice is rolled off. Every tonal layer in the combat mix has one: an
   * unfiltered oscillator at these levels is the sound of a games console, and the
   * thing that separates a low note from a low *impact* is what is missing above it.
   */
  lowpass?: number;
}

/**
 * How much of a voice is sent to the reverb. Three levels rather than a continuous
 * one, because a per-voice send would mean a gain node per voice for the send *and*
 * the envelope, and three is enough to build depth: dry for anything in the player's
 * hands, `near` for the things they do to the world, `far` for the things that happen
 * to it at a distance.
 */
type Send = 'dry' | 'near' | 'far';

/**
 * What the interface can ask the mix for. Deliberately a short list: these are
 * acknowledgements, not gameplay cues, and every one of them is built from the same
 * primitives the rest of the bus uses.
 */
export type UiCue = 'hover' | 'select' | 'confirm' | 'cancel' | 'result';

/**
 * How long the results stinger waits before it plays.
 *
 * The `complete` event fires as the run finishes and the results screen mounts on
 * the same frame, so a stinger at zero would land on top of a cue that is still
 * ringing -- and AUDIT.md section 5 records what it cost the last time two sounds
 * were confused for each other. `complete` runs long; this clears it.
 */
const RESULT_STINGER_DELAY = 0.95;

/** Beyond this a source contributes nothing, so distant fights stay out of the way. */
const MAX_AUDIBLE_METRES = 55;
/** Cap on impact ticks per batch, so a shotgun shell does not fire eight voices. */
const MAX_IMPACTS_PER_BATCH = 2;

/** Resting level of the bus everything passes through, and the level a duck returns to. */
const BUS_LEVEL = 0.75;
/** How quickly the player's own level follows the slider. Short: this is a de-click. */
const VOLUME_FOLLOW_SECONDS = 0.05;
/**
 * The duck. This is the mix's punctuation: on the few events that matter, everything
 * else is pulled down hard, held, and let back up. What it buys is not quiet -- it is
 * the *return*, which is what makes a kill feel like it displaced the rest of the
 * world for a moment.
 *
 * The attack is an order of magnitude faster than the release, on purpose. A slow duck
 * sounds like a mistake; a slow recovery sounds like a decision.
 */
const DUCK_ATTACK_SECONDS = 0.012;
const DUCK_HOLD_SECONDS = 0.07;

/**
 * The bed.
 *
 * A floor and a movement layer, and the split is the whole design. The floor is a fifth --
 * 34 Hz under 51 -- held nearly constant so the mix has a bottom to sit on and the duck has
 * something to remove; it is louder in a live room than in a corridor, which is how a room
 * gets weight without music. The movement layer is filtered noise that opens with speed,
 * giving the movement kit the audible half of a cue the renderer has had since AUDIT.md
 * section 3.3: the frame already widens with speed and the mix said nothing.
 *
 * Every level here sits well under a transient -- a shot's sub is 0.13 and a kill's is
 * 0.16 -- because a bed you notice is a bed you turn off.
 */
const BED = {
  /** Fundamental and the fifth above it. */
  floorHz: 34,
  fifthHz: 51,
  /** Floor level with nothing active, and with a room live. */
  floorQuiet: 0.022,
  floorEngaged: 0.05,
  /** Hostiles at which the room is as heavy as it gets. */
  threatFull: 5,
  /** Movement layer at a standstill and at full tilt. */
  driveQuiet: 0,
  driveFull: 0.07,
  /** Speed the movement layer starts opening at, and where it is fully open. */
  driveFromSpeed: 4,
  driveFullSpeed: 20,
  /** Where the movement layer is filtered, closed and open. */
  driveCutoffLow: 90,
  driveCutoffHigh: 430,
  /**
   * How quickly the layers follow. Slow on purpose: a bed that tracks speed frame by frame
   * is a siren, and the point is that the player notices the *state* rather than the
   * tracking.
   */
  followSeconds: 0.45,
} as const;

/**
 * Length of the generated impulse response, how sharply it decays, and how dark it is.
 *
 * The tail is deliberately long and heavily damped. An undamped noise decay is a hiss,
 * which is the last thing a low-register mix wants sitting on top of it; the one-pole
 * coefficient rolls the reflections off so what comes back is body rather than air.
 */
const REVERB_SECONDS = 1.9;
const REVERB_DECAY = 3.1;
const REVERB_DAMPING = 0.085;

/**
 * How hard the low end is driven.
 *
 * A pure sine at 40 Hz is inaudible on a laptop, a phone, or anything else without a
 * woofer -- the fundamental is below what the speaker can move. Saturating it generates
 * harmonics at 80, 120, 160 Hz, which those speakers *can* move, and the ear
 * reconstructs the missing fundamental from them. This is why the low end can be the
 * loudest thing in the mix and still be heard as weight rather than as a rumble, and it
 * is the difference between a bass-heavy mix and a mix with the bass turned up.
 */
const SUB_DRIVE = 2.6;
/** Where the driven harmonics are rolled off, so the grit stays warm rather than buzzy. */
const SUB_TONE_HZ = 760;

/**
 * The whole mix, and it is deliberately built from the bottom.
 *
 * The register is the design. Every cue is a **sub** carrying the weight, a **boom** of
 * lowpassed noise carrying the body, and at most a few milliseconds of **tick** for
 * definition -- in that order of importance. Almost nothing here has content above
 * about 1.6 kHz, and what does is under 0.04 gain and under eight milliseconds long.
 *
 * The version this replaces was built the other way up: square and sawtooth
 * fundamentals at 300 to 1500 Hz with fast decays, one or two layers each, and no low
 * end under any of it. That is the recipe for arcade, and no amount of level or reverb
 * fixes it -- a 640 Hz square is a beep whether it is loud or quiet. What replaced it
 * runs the same events an octave and a half to two octaves lower, gives every impact a
 * driven sub two to five times longer than the layer above it, and keeps the top end
 * only for articulation.
 */
export class AudioManager {
  private context: AudioContext | null = null;
  /**
   * Everything passes through this, and it is the node the duck automates. Kept ahead
   * of the limiter so ducking cannot be undone by makeup gain.
   */
  private bus: GainNode | null = null;
  /**
   * The player's own level, and it sits *after* the bus rather than on it. The duck
   * writes absolute values to the bus gain, so a volume applied there would either be
   * overwritten by the next duck or have to be folded into every ramp the duck
   * schedules. One node further down the chain, the two never meet.
   */
  private master: GainNode | null = null;
  /** Kept so a volume set before the graph exists is not lost. */
  private volume = 1;
  private wetNear: GainNode | null = null;
  private wetFar: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** Saturation curve for the low end, built once. Null where `WaveShaperNode` is absent. */
  private driveCurve: Float32Array<ArrayBuffer> | null = null;
  /** Context time the current duck finishes at. A new one is refused before then. */
  private duckUntil = 0;
  /** The bed's two layers. Built with the graph, silent until `sustain` asks for them. */
  private floorGain: GainNode | null = null;
  private driveGain: GainNode | null = null;
  private driveFilter: BiquadFilterNode | null = null;

  async resume(): Promise<void> {
    if (typeof AudioContext !== 'function') return;
    try {
      this.context ??= new AudioContext();
      if (this.context.state !== 'running') await this.context.resume();
      // Order matters: the bed's movement layer loops the noise buffer and its floor is
      // saturated by the drive curve, so both have to exist before the graph is built.
      this.noiseBuffer ??= this.createNoiseBuffer(this.context, 0.5);
      this.driveCurve ??= createDriveCurve(SUB_DRIVE);
      if (!this.bus) this.buildGraph(this.context);
    } catch {
      this.context = null;
      this.bus = null;
      this.wetNear = null;
      this.wetFar = null;
    }
  }

  consume(events: readonly GameEvent[], listener?: AudioListenerState): void {
    if (!this.context || this.context.state !== 'running') return;
    let impacts = 0;
    for (const event of events) {
      const place = this.placement(event, listener);
      // Deterministic per-event variation. Presentation is allowed to be arbitrary but
      // it must not differ run to run, and without this a held trigger is a machine gun
      // of one identical waveform -- the most artificial thing a synth mix can do and
      // the cheapest to fix.
      const vary = variation(event.id, 0.055);
      switch (event.kind) {
        case 'shot':
          // Sub first. The tick is five milliseconds of definition so the shot has an
          // edge; everything a player actually feels is under 200 Hz. Always centred
          // and always at full level -- it is the one sound that must never be masked.
          this.tick(1300 * vary, 0.005, 0.028, 0, 'dry');
          this.boom(190 * vary, 0.13, 0.11, 0, 'near');
          this.sub(58 * vary, 0.3, 0.13, 0.42, 0, 'dry');
          this.tone({ frequency: 96 * vary, duration: 0.16, gain: 0.05, type: 'sine', bend: 0.5, lowpass: 300 }, 0, 0, 'dry');
          break;
        case 'dryFire':
          this.tick(1500, 0.006, 0.03, 0, 'dry');
          this.boom(260, 0.05, 0.03, 0, 'near');
          break;
        case 'impact':
          // Body shots already get the confirm, so only surfaces tick here. Both layers
          // vary per event, so a shotgun pattern reads as debris rather than as the same
          // tick eight times.
          if (event.targetEntityId !== undefined || impacts >= MAX_IMPACTS_PER_BATCH) break;
          impacts += 1;
          this.boom(320 * vary, 0.06, 0.04 * place.gain, place.pan, place.send);
          this.tick(1400 * vary, 0.004, 0.012 * place.gain, place.pan, place.send);
          break;
        case 'hit':
          if (this.isPlayer(event.targetEntityId, listener)) this.playerDamaged(event.value ?? 0);
          // A shot the shield ate is a dull, dead thud with no sub under it: the player
          // should hear that they connected and that it did not count. Taking the weight
          // away is a clearer statement than turning the volume down.
          else if (event.deflected) this.boom(150, 0.07, 0.05, 0, 'near');
          else {
            // The confirm is a thud, not a blip. A headshot's sub sits a fourth higher
            // and its tick is brighter, so precision is audible without either of them
            // leaving the register.
            this.sub(event.headshot ? 120 : 84, event.headshot ? 0.13 : 0.11, event.headshot ? 0.06 : 0.055, 0.58, 0, 'dry');
            this.tick(event.headshot ? 1600 : 1100, 0.004, event.headshot ? 0.022 : 0.016, 0, 'dry');
          }
          break;
        case 'kill':
          // The biggest moment in the loop, and the only cue with two subs an octave
          // apart: the upper one is the impact, the lower one is what is left of it.
          // Plus the longest tail in the mix and the duck that clears room for it.
          this.duck(0.58, 0.34);
          this.tick(1500, 0.006, 0.03, 0, 'dry');
          this.sub(104, 0.62, 0.16, 0.24, 0, 'near');
          this.sub(52, 0.5, 0.1, 0.5, 0, 'near');
          this.boom(150, 0.4, 0.09, 0, 'far');
          break;
        case 'melee':
          // A swing that connected and a swing that cut air are different sounds, not
          // the same sound at two levels. The whiff is dark air and nothing else; the
          // cut is the heaviest sub in ordinary play. This is the primary verb, so it is
          // the cue the player hears most and the one that most has to have weight.
          if (event.targetEntityId === undefined) {
            // A heavy that cut air is a longer, lower rush of nothing than a light one:
            // the whiff should tell the player how much they just committed.
            this.boom(event.heavy ? 520 : 700 * vary, event.heavy ? 0.26 : 0.16, 0.04, 0, 'near');
          } else if (event.heavy) {
            // The heaviest thing in ordinary play, and the only impact with a second sub
            // an octave down -- the same trick the kill uses, because a heavy that lands
            // on three hostiles at once should sound like it moved the room.
            this.tick(900, 0.006, 0.032, 0, 'dry');
            this.boom(170, 0.3, 0.12, 0, 'near');
            this.sub(56, 0.55, 0.17, 0.34, 0, 'near');
            this.sub(112, 0.24, 0.1, 0.4, 0, 'far');
            this.tone({ frequency: 84, duration: 0.26, gain: 0.06, type: 'sine', bend: 0.42, lowpass: 220 }, 0, 0, 'dry');
          } else {
            this.tick(1200 * vary, 0.005, 0.03, 0, 'dry');
            this.boom(220 * vary, 0.14, 0.1, 0, 'near');
            this.sub(74 * vary, 0.34, 0.15, 0.38, 0, 'near');
            this.tone({ frequency: 110 * vary, duration: 0.14, gain: 0.055, type: 'sine', bend: 0.45, lowpass: 260 }, 0, 0, 'dry');
          }
          break;
        case 'enemyTelegraph': {
          // The single most important cue in the mix: it is the only warning the player
          // gets before taking damage. It used to be a rising square in the upper mids,
          // which is alarming in the way an alarm clock is. Now it is pressure -- a low
          // swell rising through the wind-up, placed, with one tick at the front so the
          // player can tell where it came from.
          const windup = Math.max(0.12, event.value ?? 0.3);
          this.tick(1500, 0.005, 0.014 * place.gain, place.pan, 'dry');
          this.sub(46, windup, 0.075 * place.gain, 2.6, place.pan, 'near');
          this.tone({ frequency: 150, duration: windup, gain: 0.05 * place.gain, type: 'triangle', bend: 1.9, lowpass: 420 }, 0, place.pan, 'dry');
          break;
        }
        case 'enemyAttack':
          // Duller and lower than the player's own shot so the two never blur, and
          // wetter, because it happens out there rather than in their hands.
          this.boom(200, 0.1, 0.085 * place.gain, place.pan, place.send);
          this.sub(44, 0.22, 0.075 * place.gain, 0.6, place.pan, 'far');
          this.tone({ frequency: 78, duration: 0.1, gain: 0.05 * place.gain, type: 'sine', bend: 0.5, lowpass: 220 }, 0, place.pan, 'dry');
          break;
        case 'death':
          // The lowest and longest thing in the game, and the deepest duck. Everything
          // else stops mattering, and the mix says so by nearly stopping.
          this.duck(0.8, 0.9);
          this.sub(58, 1.5, 0.16, 0.42, 0, 'far');
          this.sub(29, 1.2, 0.1, 0.7, 0, 'far');
          this.boom(110, 0.9, 0.12, 0, 'far');
          break;
        case 'respawn':
          // Rises where death fell, so redeploying reads as the inverse of going down.
          this.sub(38, 0.45, 0.1, 3.4, 0, 'near');
          this.tone({ frequency: 90, duration: 0.3, gain: 0.06, type: 'triangle', bend: 2, lowpass: 300 }, 0, 0, 'near');
          break;
        case 'comboLink': {
          // Pitch climbs with the chain, so the chain is audible without being read --
          // but it climbs from 68 Hz rather than 520, so a long chain gets heavier
          // rather than shriller. Sixteen links tops out around 128 Hz.
          const step = Math.min(16, event.value ?? 1);
          this.sub(68 * (1 + step * 0.055), 0.1, 0.06, 1.15, 0, 'near');
          break;
        }
        case 'dodge':
          // The loudest thing the player can earn short of a kill, and it has to cut
          // through a telegraph that is still ringing -- so it ducks the telegraph out
          // from under itself. It is not distinguished by being higher than the warning
          // it answers: it is distinguished by rising three times as fast, by the tick
          // at the front, and by being the only rising sub in the mix at that level.
          this.duck(0.5, 0.26);
          this.tick(2200, 0.008, 0.04, 0, 'dry');
          this.sub(58, 0.34, 0.15, 3.2, 0, 'near');
          this.boom(320, 0.2, 0.07, 0, 'far');
          this.tone({ frequency: 130, duration: 0.22, gain: 0.05, type: 'triangle', bend: 2.4, lowpass: 520 }, 0, 0, 'far');
          break;
        case 'comboBreak':
          this.sub(90, 0.3, 0.07, 0.42, 0, 'near');
          break;
        case 'split':
          this.sub(80, 0.16, 0.06, 1.5, 0, 'near');
          this.tick(1400, 0.005, 0.018, 0, 'near');
          break;
        case 'reloadStart':
          this.tick(1200, 0.006, 0.03, 0, 'dry');
          this.boom(340, 0.05, 0.035, 0, 'dry');
          break;
        case 'reloadComplete':
          this.tick(1600, 0.005, 0.032, 0, 'dry');
          this.boom(240, 0.06, 0.045, 0, 'dry');
          this.sub(90, 0.08, 0.04, 0.8, 0, 'dry');
          break;
        case 'checkpoint':
          this.sub(62, 0.5, 0.09, 1.6, 0, 'near');
          this.tone({ frequency: 124, duration: 0.35, gain: 0.05, type: 'sine', lowpass: 320 }, 0, 0, 'far');
          break;
        case 'complete':
          this.duck(0.42, 0.5);
          this.sub(52, 0.9, 0.12, 1.5, 0, 'far');
          this.tone({ frequency: 104, duration: 0.6, gain: 0.06, type: 'sine', lowpass: 300 }, 0, 0, 'far');
          this.tone({ frequency: 156, duration: 0.5, gain: 0.04, type: 'sine', lowpass: 380 }, 0.18, 0, 'far');
          break;
        case 'wave':
          // A room that is not finished with you. Long, low and rising, deliberately
          // close to the gate's swell -- both mean the geometry of the fight just
          // changed -- but shorter, and with a tick so it lands rather than looms.
          this.tick(1000, 0.006, 0.026, 0, 'near');
          this.sub(36, 0.85, 0.12, 2.4, 0, 'far');
          this.boom(140, 0.5, 0.08, 0, 'far');
          break;
        case 'gateOpen':
          // A thirty-metre door. The sub is the entire point of it.
          this.sub(30, 1.1, 0.13 * place.gain, 2.2, place.pan, 'far');
          this.boom(120, 0.8, 0.09 * place.gain, place.pan, 'far');
          break;
        case 'grappleAttach':
          this.tick(1700, 0.005, 0.028, 0, 'dry');
          this.sub(96, 0.14, 0.07, 0.7, 0, 'near');
          break;
        case 'grapplePull':
          this.sub(80, 0.12, 0.075, 1.5, 0, 'near');
          break;
        case 'grappleRelease':
          this.sub(70, 0.1, 0.045, 0.7, 0, 'near');
          break;
        case 'grappleFail':
          this.boom(180, 0.05, 0.03, 0, 'dry');
          break;
        default:
          break;
      }
    }
  }

  /**
   * An acknowledgement from the interface.
   *
   * Kept audibly apart from the combat mix on purpose, and the separation is now
   * register as well as material: the run lives under 200 Hz, so the interface sits
   * *above* it, at 200 to 400 Hz, rather than the other way round. Everything here is
   * square or triangle, never the sine the run is built from, and hover and select are
   * an order of magnitude below the hit confirm. Nothing here ducks, either -- the duck
   * belongs to the run, and a menu that pulled the mix down under the pointer would
   * spend the effect on nothing.
   */
  cue(kind: UiCue): void {
    if (!this.context || this.context.state !== 'running') return;
    switch (kind) {
      case 'hover':
        // Barely there. A menu that clicks loudly under the pointer is a menu the
        // player mutes, so this sits well under every other voice in the bus.
        this.tone({ frequency: 420, duration: 0.026, gain: 0.013, type: 'triangle', lowpass: 900 }, 0, 0, 'dry');
        break;
      case 'select':
        this.tick(1100, 0.006, 0.022, 0, 'dry');
        this.tone({ frequency: 240, duration: 0.035, gain: 0.024, type: 'square', lowpass: 700 }, 0, 0, 'dry');
        break;
      case 'confirm':
        // Rises a fifth. Square and lowpassed, so it cannot blur into the sine layer
        // the run is built from.
        this.tone({ frequency: 220, duration: 0.07, gain: 0.05, type: 'square', lowpass: 640 }, 0, 0, 'dry');
        this.tone({ frequency: 330, duration: 0.1, gain: 0.04, type: 'square', lowpass: 760 }, 0.06, 0, 'near');
        this.tick(1300, 0.005, 0.022, 0, 'dry');
        break;
      case 'cancel':
        // The inverse: one note, falling.
        this.tone({ frequency: 200, duration: 0.13, gain: 0.045, type: 'square', bend: 0.6, lowpass: 560 }, 0, 0, 'dry');
        break;
      case 'result': {
        // A stab under the rank landing, an octave and a half below where it used to
        // sit. Delayed so it does not land on top of the `complete` cue the run itself
        // just played, which is now nearly a second long.
        const notes: readonly [number, number][] = [[131, 0], [196, 0.09], [262, 0.18]];
        for (const [frequency, offset] of notes) {
          this.tone({ frequency, duration: 0.55 - offset, gain: 0.05, type: 'square', lowpass: 620 }, RESULT_STINGER_DELAY + offset, 0, 'far');
        }
        // A root under the stab. A tone rather than a sub, because `sub` takes no delay
        // and would have fired at zero, straight over the tail of the `complete` cue
        // this whole thing is offset to avoid.
        this.tone({ frequency: 65, duration: 0.6, gain: 0.055, type: 'triangle', lowpass: 200 }, RESULT_STINGER_DELAY, 0, 'near');
        break;
      }
      default:
        break;
    }
  }

  /**
   * The player's level, 0 to 1. Ramped rather than set, because a slider drags through
   * every value between where it was and where it lands, and stepping a gain node per
   * pointer move is a click per step.
   *
   * Safe to call before a gesture has opened the context: the value is held and applied
   * when the graph is built.
   */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    const context = this.context;
    if (!context || !this.master) return;
    this.master.gain.setTargetAtTime?.(this.volume, context.currentTime, VOLUME_FOLLOW_SECONDS);
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.bus = null;
    this.master = null;
    this.wetNear = null;
    this.wetFar = null;
    this.noiseBuffer = null;
    this.driveCurve = null;
    this.floorGain = null;
    this.driveGain = null;
    this.driveFilter = null;
    this.duckUntil = 0;
  }

  /**
   * Damage taken is deliberately built from different material than damage dealt: a
   * long low thud and a falling tone, never the confirm. Reading the mix has to tell
   * the player which direction the transaction went -- and it ducks, because being hit
   * is one of the few things that should stop the rest of the world.
   */
  private playerDamaged(amount: number): void {
    const weight = Math.min(1, Math.max(0.25, amount / 25));
    this.duck(0.4 * weight, 0.26);
    this.sub(60, 0.42, 0.15 * weight, 0.5, 0, 'near');
    this.boom(150, 0.2, 0.11 * weight, 0, 'near');
    this.tone({ frequency: 88, duration: 0.28, gain: 0.07 * weight, type: 'sine', bend: 0.4, lowpass: 240 }, 0, 0, 'dry');
  }

  /**
   * Pulls the whole bus down, holds it, and lets it back up.
   *
   * One duck at a time: a second request inside a live one is refused rather than
   * layered, for the same reason hitstop has a refractory gap. Overlapping ducks do not
   * add drama, they add pumping, and the effect only reads as deliberate if it is rare.
   * Kills, deaths, dodges, damage taken and the run completing -- and nothing else.
   * Ducking on every landed slash, at four a second, would be a tremolo.
   */
  private duck(depth: number, releaseSeconds: number): void {
    const context = this.context;
    const bus = this.bus;
    if (!context || !bus) return;
    const now = context.currentTime;
    if (now < this.duckUntil) return;
    const floor = Math.max(0.0001, BUS_LEVEL * (1 - Math.min(0.95, Math.max(0, depth))));
    const holdEnds = now + DUCK_ATTACK_SECONDS + DUCK_HOLD_SECONDS;
    this.duckUntil = holdEnds + releaseSeconds;
    bus.gain.cancelScheduledValues?.(now);
    bus.gain.setValueAtTime(BUS_LEVEL, now);
    bus.gain.exponentialRampToValueAtTime(floor, now + DUCK_ATTACK_SECONDS);
    bus.gain.setValueAtTime(floor, holdEnds);
    bus.gain.exponentialRampToValueAtTime(BUS_LEVEL, this.duckUntil);
  }

  /**
   * Distance attenuation, stereo placement, and how wet a world event should be. The
   * last one is most of the depth in the mix: something happening forty metres down the
   * route arrives mostly as its own reflections, and something in the player's hands
   * arrives with none.
   */
  private placement(event: GameEvent, listener?: AudioListenerState): { gain: number; pan: number; send: Send } {
    const source = event.origin ?? event.position;
    if (!listener || !source) return { gain: 1, pan: 0, send: 'dry' };
    const dx = source[0] - listener.position[0];
    const dy = source[1] - listener.position[1];
    const dz = source[2] - listener.position[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.001) return { gain: 1, pan: 0, send: 'dry' };
    // Matches the simulation's basis: forward is (-sin yaw, -cos yaw), so right is
    // (cos yaw, -sin yaw) and a positive dot puts the source to the player's right.
    const pan = (dx * Math.cos(listener.yaw) + dz * -Math.sin(listener.yaw)) / distance;
    return {
      gain: Math.max(0, 1 - distance / MAX_AUDIBLE_METRES) ** 1.4,
      pan,
      send: distance > MAX_AUDIBLE_METRES * 0.3 ? 'far' : 'near',
    };
  }

  private isPlayer(entityId: number | undefined, listener?: AudioListenerState): boolean {
    return entityId !== undefined && entityId === listener?.playerId;
  }

  /**
   * The graph, built once.
   *
   *     voices -> bus -> limiter -> destination
   *     voices -> wetNear | wetFar -> reverb -> bus
   *
   * Two things about the order are deliberate. The reverb returns *into* the bus, so a
   * duck takes the tails down with the dry signal instead of leaving them ringing over
   * a hole. And the limiter sits after the bus rather than before it, so it glues the
   * layers together without fighting the duck for control of the level -- a compressor
   * ahead of the ducking node would spend the whole release pushing the gain back up.
   *
   * Every optional node is feature-detected. `createStereoPanner` already was, because
   * the test harness has no Web Audio at all and implements only the surface this class
   * uses; the reverb, the limiter and the low-end saturation follow the same rule, and
   * the mix degrades to dry, unlimited and clean rather than throwing.
   */
  private buildGraph(context: AudioContext): void {
    const bus = context.createGain();
    bus.gain.value = BUS_LEVEL;
    const master = context.createGain();
    // Scheduled rather than assigned, because unlike every other level in the graph
    // this one is state the player owns: it may already have been set from the save
    // before a gesture existed to open the context, and it has to land here exactly.
    master.gain.setValueAtTime(this.volume, context.currentTime);
    const limiter = typeof context.createDynamicsCompressor === 'function' ? this.createLimiter(context) : null;
    // Volume ahead of the limiter, so turning the mix down turns down what the limiter
    // is given rather than what it produced -- a quiet mix should be less compressed,
    // not the same compression at a lower level.
    if (limiter) bus.connect(master).connect(limiter).connect(context.destination);
    else bus.connect(master).connect(context.destination);
    this.bus = bus;
    this.master = master;

    if (typeof context.createConvolver !== 'function') return;
    const reverb = context.createConvolver();
    reverb.buffer = this.createImpulseResponse(context);
    reverb.connect(bus);
    // Two fixed send levels. See `Send` for why this is three states and not a knob.
    const near = context.createGain();
    near.gain.value = 0.17;
    near.connect(reverb);
    const far = context.createGain();
    far.gain.value = 0.44;
    far.connect(reverb);
    this.wetNear = near;
    this.wetFar = far;
    this.buildBed(context, bus);
  }

  /**
   * The bed, built once and started immediately at zero gain.
   *
   * Started here rather than lazily on the first `sustain` for two reasons. An oscillator
   * cannot be restarted once stopped, so the alternative is building and tearing one down
   * per run. And it keeps the graph's shape fixed: everything that exists, exists from
   * `resume`, which is what lets the whole mix be exercised against a test double.
   *
   * It routes into the bus, not past it, so a duck takes the floor away with the rest --
   * which is the entire reason the bed is here.
   */
  private buildBed(context: AudioContext, bus: GainNode): void {
    const floor = context.createGain();
    floor.gain.value = 0;
    floor.connect(bus);
    for (const [frequency, type, level] of [[BED.floorHz, 'sine', 1], [BED.fifthHz, 'triangle', 0.45]] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 190;
      filter.Q.value = 0.6;
      const layer = context.createGain();
      layer.gain.value = level;
      const shaper = this.driveCurve && typeof context.createWaveShaper === 'function' ? context.createWaveShaper() : null;
      if (shaper) {
        shaper.curve = this.driveCurve;
        oscillator.connect(shaper).connect(filter);
      } else {
        oscillator.connect(filter);
      }
      filter.connect(layer).connect(floor);
      oscillator.start();
    }
    this.floorGain = floor;

    // The movement layer. Noise rather than a tone, because speed is a rush and not a
    // note, and lowpassed hard so it stays underneath everything.
    const drive = context.createGain();
    drive.gain.value = 0;
    drive.connect(bus);
    const driveFilter = context.createBiquadFilter();
    driveFilter.type = 'lowpass';
    driveFilter.frequency.value = BED.driveCutoffLow;
    driveFilter.Q.value = 1.1;
    driveFilter.connect(drive);
    if (this.noiseBuffer) {
      const source = context.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;
      source.connect(driveFilter);
      source.start();
    }
    this.driveGain = drive;
    this.driveFilter = driveFilter;
  }

  /**
   * Follows the run. Called every frame, and everything it touches is a smoothed target
   * rather than a value, so the bed reports the player's *state* instead of tracking their
   * velocity frame by frame -- which would be a siren.
   */
  sustain(state: AudioSustainState): void {
    const context = this.context;
    if (!context || context.state !== 'running' || !this.floorGain || !this.driveGain || !this.driveFilter) return;
    const now = context.currentTime;
    const engaged = Math.min(1, Math.max(0, state.threat / BED.threatFull));
    const speed = Math.min(1, Math.max(0, (state.speed - BED.driveFromSpeed) / (BED.driveFullSpeed - BED.driveFromSpeed)));
    // Down is silence, not a quieter version of being alive: the floor going out from
    // under the player is the loudest thing about dying.
    const floor = state.down ? 0 : BED.floorQuiet + (BED.floorEngaged - BED.floorQuiet) * engaged;
    const drive = state.down ? 0 : BED.driveQuiet + (BED.driveFull - BED.driveQuiet) * speed;
    this.floorGain.gain.setTargetAtTime?.(floor, now, BED.followSeconds);
    this.driveGain.gain.setTargetAtTime?.(drive, now, BED.followSeconds);
    this.driveFilter.frequency.setTargetAtTime?.(
      BED.driveCutoffLow + (BED.driveCutoffHigh - BED.driveCutoffLow) * speed,
      now,
      BED.followSeconds,
    );
  }

  /**
   * Glue, not colour. Layered stings peak far higher than the sum of their authored
   * gains suggests, and a mix led by its low end peaks higher still -- without this the
   * loud moments clip the output rather than getting heavier.
   */
  private createLimiter(context: AudioContext): DynamicsCompressorNode {
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 6;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    return limiter;
  }

  private createNoiseBuffer(context: AudioContext, seconds: number): AudioBuffer {
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
    const channel = buffer.getChannelData(0);
    // Deterministic noise: presentation is allowed to be arbitrary but it should
    // not differ run to run for the same event.
    let state = 0x9e3779b9;
    for (let index = 0; index < channel.length; index += 1) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      channel[index] = ((state >>> 0) / 0x8000_0000) - 1;
    }
    return buffer;
  }

  /**
   * A synthesised room: decaying noise, damped by a one-pole lowpass as it is generated
   * and built independently per channel so the tail spreads instead of sitting in the
   * middle of the head. Generated rather than loaded because a recorded impulse would be
   * the only sample in a project whose entire mix is synthesised, and a download the
   * player waits on before they can hear anything.
   */
  private createImpulseResponse(context: AudioContext): AudioBuffer {
    const length = Math.ceil(context.sampleRate * REVERB_SECONDS);
    const buffer = context.createBuffer(2, length, context.sampleRate);
    let state = 0x2545f491;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      let damped = 0;
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        const noise = ((state >>> 0) / 0x8000_0000) - 1;
        damped += (noise - damped) * REVERB_DAMPING;
        data[index] = damped * (1 - index / length) ** REVERB_DECAY;
      }
    }
    return buffer;
  }

  /**
   * Per-voice tail of the graph. A panned voice needs its own panner, which has to be
   * torn down when the voice ends -- otherwise every placed sound leaves a node
   * connected to the bus for the rest of the session. The reverb send is taken from the
   * voice's own envelope rather than from after the panner, so it costs no extra node.
   */
  private output(pan: number, send: Send): { destination: AudioNode; wet: AudioNode | null; release: () => void } | null {
    const context = this.context;
    const bus = this.bus;
    if (!context || !bus) return null;
    const wet = send === 'near' ? this.wetNear : send === 'far' ? this.wetFar : null;
    if (pan === 0 || typeof context.createStereoPanner !== 'function') {
      return { destination: bus, wet, release: () => {} };
    }
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(bus);
    return { destination: panner, wet, release: () => panner.disconnect() };
  }

  /**
   * Definition. Four to eight milliseconds of band-limited noise, and the only thing in
   * the combat mix that reaches past 1 kHz.
   *
   * It is here because a mix built entirely from low content is mud: the ear places an
   * impact from its first millisecond, and without a transient every hit arrives late
   * and vague however heavy it is. It is kept this short and this quiet because past
   * about ten milliseconds and 0.04 gain it stops being an edge and starts being the
   * beep this whole pass exists to remove.
   */
  private tick(cutoff: number, duration: number, gainValue: number, pan: number, send: Send): void {
    this.noise('bandpass', cutoff, 1.4, duration, gainValue, pan, send);
  }

  /**
   * Body. Lowpassed noise, which is weight with no pitch -- the layer that says how big
   * a thing was without saying what note it was.
   */
  private boom(cutoff: number, duration: number, gainValue: number, pan: number, send: Send): void {
    this.noise('lowpass', cutoff, 0.7, duration, gainValue, pan, send);
  }

  private noise(
    type: BiquadFilterType,
    cutoff: number,
    q: number,
    duration: number,
    gainValue: number,
    pan: number,
    send: Send,
  ): void {
    const context = this.context;
    const output = this.output(pan, send);
    if (!context || !output || !this.noiseBuffer || gainValue <= 0.0005) {
      output?.release();
      return;
    }
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = cutoff;
    filter.Q.value = q;
    const gain = context.createGain();
    gain.gain.setValueAtTime(gainValue, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    source.connect(filter).connect(gain).connect(output.destination);
    if (output.wet) gain.connect(output.wet);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
      output.release();
    };
    source.start();
    source.stop(context.currentTime + duration);
  }

  /**
   * The sub, and the mix is built on it. A sine falling -- or rising -- through the
   * bottom two octaves, saturated so it survives a speaker that cannot reproduce the
   * fundamental, then rolled off so the harmonics stay warm.
   *
   * `drop` is the ratio the pitch travels to: well under one for an impact, well over
   * one for something opening, and around three for the only rising sub in the mix,
   * which is the perfect dodge.
   */
  private sub(frequency: number, duration: number, gainValue: number, drop: number, pan: number, send: Send): void {
    const context = this.context;
    const output = this.output(pan, send);
    if (!context || !output || gainValue <= 0.0005) {
      output?.release();
      return;
    }
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(18, frequency * drop), now + duration);
    const shaper = this.driveCurve && typeof context.createWaveShaper === 'function'
      ? context.createWaveShaper()
      : null;
    if (shaper) shaper.curve = this.driveCurve;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = SUB_TONE_HZ;
    filter.Q.value = 0.5;
    const gain = context.createGain();
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    // Saturate before filtering: the harmonics have to exist before anything can decide
    // where to stop them. The other order is just a quiet sine.
    if (shaper) oscillator.connect(shaper).connect(filter);
    else oscillator.connect(filter);
    filter.connect(gain).connect(output.destination);
    if (output.wet) gain.connect(output.wet);
    oscillator.onended = () => {
      oscillator.disconnect();
      shaper?.disconnect();
      filter.disconnect();
      gain.disconnect();
      output.release();
    };
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  private tone(
    { frequency, duration, gain: gainValue, type, bend, lowpass }: Voice,
    delaySeconds: number,
    pan: number,
    send: Send = 'dry',
  ): void {
    const context = this.context;
    const output = this.output(pan, send);
    if (!context || !output || gainValue <= 0.0005) {
      output?.release();
      return;
    }
    const startAt = context.currentTime + Math.max(0, delaySeconds);
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    if (bend && bend !== 1) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, frequency * bend), startAt + duration);
    const filter = lowpass ? context.createBiquadFilter() : null;
    if (filter && lowpass) {
      filter.type = 'lowpass';
      filter.frequency.value = lowpass;
      filter.Q.value = 0.6;
    }
    const gain = context.createGain();
    gain.gain.setValueAtTime(gainValue, startAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    if (filter) oscillator.connect(filter).connect(gain);
    else oscillator.connect(gain);
    gain.connect(output.destination);
    if (output.wet) gain.connect(output.wet);
    oscillator.onended = () => {
      oscillator.disconnect();
      filter?.disconnect();
      gain.disconnect();
      output.release();
    };
    oscillator.start(startAt);
    oscillator.stop(startAt + duration);
  }
}

/**
 * A stable multiplier in `1 ± spread` for an event id. Hashed rather than random, so
 * the same event always sounds the same way -- the rule the noise buffer is generated
 * under too.
 */
function variation(id: number, spread: number): number {
  const hashed = Math.imul(id ^ 0x27d4_eb2d, 0x9e37_79b9) >>> 0;
  return 1 + ((hashed % 1000) / 1000 - 0.5) * 2 * spread;
}

/**
 * A soft-clipping transfer curve. `tanh`-shaped rather than a hard clip, so quiet
 * material passes nearly untouched and loud material folds over gradually instead of
 * squaring off into a buzz.
 */
function createDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const x = (index / (samples - 1)) * 2 - 1;
    curve[index] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}
