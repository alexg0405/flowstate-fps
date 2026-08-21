import type { BladeStyleId, BotProfile, GameEvent, Vec3, WeaponChassisId } from '../contracts';
// The one run number the mix reads. A heal's level is a fraction of the largest heal the
// game can pay, and keeping a second copy of that ceiling here is exactly the two-sources
// -of-truth problem the tuning rules exist to prevent.
import { lifesteal } from '../content/config';

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
  /**
   * How open the space is, 0 enclosed and 1 exposed, which decides which room the tail
   * comes back from. See `ROOMS`, and `content/config.ts` for where the number comes from.
   */
  space: number;
  /**
   * The flow chain, which is the game's measure of playing well and had almost no voice
   * in the mix. Driven from here rather than from `consume` deliberately: see `CHAIN`.
   */
  chain: {
    links: number;
    /**
     * Fraction of the link window still open. The colour note fades with the last of it,
     * so a chain about to lapse is audible as the thing the player is about to lose
     * dimming rather than as a warning arriving.
     */
    window: number;
  };
}

/** Where the player is and which way they face, so threats can be placed in the mix. */
export interface AudioListenerState {
  position: Vec3;
  yaw: number;
  playerId: number;
  /**
   * Every live hostile, by entity id. Presentation already knows all of this --
   * `EntitySnapshot` has carried it since the characters were authored -- and the mix
   * needs two different things from it. Without `kind` it cannot tell a slash into a
   * brawler from a slash into a plate, which is the difference between the two most
   * common impacts in the game. Without `position` and `facing` it cannot tell a hostile
   * that is *about to shoot the player* from one that happens to be nearby, which is the
   * difference between a warning and a noise. Absent for callers that have no roster, in
   * which case every target is the reference material at the reference threat.
   */
  roster?: ReadonlyMap<number, AudioHostile>;
}

/** One live hostile, as the mix sees it. */
export interface AudioHostile {
  kind: BotProfile['kind'];
  position: Vec3;
  /** Which way it is pointing, in radians, in the simulation's own basis. */
  facing: number;
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
 * Where a source is, in every term the mix has for saying so: how loud, which side, how
 * much of the room, how late, how dark, and how much of its edge survived the trip.
 */
interface Placement {
  gain: number;
  pan: number;
  send: Send;
  /** Seconds of flight, which is the part of distance a level cannot say. */
  delay: number;
  /** Multiplier on a noise layer's cutoff. Air takes the top off before the bottom. */
  cutoffScale: number;
  /** Multiplier on a transient's level, which rolls off faster than the body's. */
  edge: number;
  /** Decibels of priority the source's intent is worth. See `THREAT`. */
  importanceLift: number;
}

/** In the player's hands: no distance, no flight, no absorption, no threat. */
const HERE: Placement = { gain: 1, pan: 0, send: 'dry', delay: 0, cutoffScale: 1, edge: 1, importanceLift: 0 };

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

/** The simulation's fixed step, which is the clock every cue is now scheduled against. */
const STEP_SECONDS = 1 / 60;

/**
 * Metres a second, and the reason distance is a *time* here rather than only a level.
 *
 * Real gunfire arrives as two events -- the crack that travels with the round and the
 * thump of the muzzle blast -- and the gap between them is how an experienced listener
 * ranges a shooter. At this route's distances that gap is 116 ms at forty metres, which
 * is audible, free, and the difference between "something fired somewhere" and
 * "something fired *over there*". It costs no node: every cue in this mix is a one-shot,
 * so the delay is simply when it is scheduled to start.
 */
const SPEED_OF_SOUND = 343;

/**
 * Air absorption, expressed as the distance at which a body layer's cutoff is halved.
 *
 * High frequencies are absorbed far faster than low ones, so a distant shot is a muffled
 * boom with no edge at all. Two terms, because the mix has two kinds of layer: the noise
 * layers' cutoffs are scaled by `1 / (1 + distance / this)`, and the transient -- which
 * is nothing *but* edge -- additionally loses level, because a tick that is filtered
 * rather than removed is just a duller beep.
 */
const AIR_ABSORPTION_METRES = 14;
/** Extra exponent on a transient's distance rolloff, over the body's own. */
const EDGE_ROLLOFF = 1.9;

/**
 * The mix's dynamic range, and the generalisation of two caps that were written by hand.
 *
 * Frostbite tags every asset with a loudness across the whole range of hearing and slides
 * a window over it: the window rises to encompass the loudest thing sounding, anything
 * more than a fixed range under it is culled, and relative levels are preserved -- so a
 * surface tick is inaudible while a kill lands and audible again a second later. That is
 * one number per cue and one shared window, where this file had `MAX_IMPACTS_PER_BATCH`
 * and `MAX_KILLS_PER_BATCH`: the right instinct, implemented twice, for two of the two
 * dozen cues that can stack.
 *
 * The window is a cull and not a compressor on purpose. Every level in this file was
 * authored against the others; scaling them at runtime would be a second mix fighting the
 * first. What the window decides is what is *not worth a voice*, which is the decision
 * the two constants it replaces were making.
 */
const HDR = {
  /** A cue more than this far under the window's top is not played at all. */
  rangeDb: 26,
  /** The range tightens to this once the graph is already carrying `softVoices`. */
  pressuredRangeDb: 14,
  /** How fast the window falls back once nothing loud is sounding. */
  fallDbPerSecond: 34,
  /**
   * Where the window rests. Without a floor it would drift down through a quiet corridor
   * and stop meaning anything; at -14 the quietest cue in the table is still 26 dB clear
   * of being culled by silence.
   */
  restDb: -14,
  /** Voices sounding at once before the range tightens, and the hard ceiling. */
  softVoices: 18,
  hardVoices: 32,
} as const;

/**
 * What each cue is worth, and how many of it may sound at once.
 *
 * `importance` is in decibels under the loudest thing the game plays, which is a kill,
 * and it is deliberately *not* the authored gain. A telegraph is one of the quietest cues
 * in the mix and must never be culled, because it is the only warning the player gets; a
 * surface tick is not especially quiet and is the first thing that should go. Loudness is
 * priority, but only once someone has said what the priority is.
 *
 * `limit` is the playback limit middleware ships for the same reason: how many instances
 * of one cue may sound in a single batch. Two of these numbers used to be constants of
 * their own -- a shotgun pattern firing eight identical ticks, and three bodies going down
 * on one tick producing the same waveform nine decibels louder.
 */
interface CuePolicy {
  importance: number;
  /** Instances allowed per batch. Absent means as many as the events ask for. */
  limit?: number;
}

const CUE: Record<GameEvent['kind'], CuePolicy> = {
  kill: { importance: 0, limit: 2 },
  death: { importance: 0 },
  dodge: { importance: -2 },
  complete: { importance: -2 },
  wave: { importance: -4 },
  respawn: { importance: -4 },
  shot: { importance: -6 },
  gateOpen: { importance: -6 },
  /** Never culled by anything short of a death: it is the only warning in the game. */
  enemyTelegraph: { importance: -7, limit: 3 },
  melee: { importance: -8, limit: 3 },
  checkpoint: { importance: -8 },
  enemyAttack: { importance: -10, limit: 3 },
  comboBreak: { importance: -12 },
  grappleAttach: { importance: -12 },
  grapplePull: { importance: -12 },
  comboLink: { importance: -14, limit: 2 },
  split: { importance: -14 },
  heal: { importance: -15 },
  hit: { importance: -16, limit: 3 },
  reloadComplete: { importance: -16 },
  reloadStart: { importance: -18 },
  dryFire: { importance: -18 },
  grappleRelease: { importance: -18 },
  grappleFail: { importance: -22 },
  /**
   * The cheapest thing in the mix and the first thing the window takes away. Four
   * decibels outside the window's range under a kill and inside it under everything
   * else, which is the statement: a round hitting a wall is worth hearing while the
   * player is shooting, and is not worth a voice while a body is going down.
   */
  impact: { importance: -30, limit: 2 },
};

/**
 * Damage taken, which is not the `hit` cue however it arrives.
 *
 * A round landing on the player and a round landing on a hostile are the same event kind
 * with the same authored table entry, and they could hardly be further apart in what they
 * are worth: one is a confirm and the other is the mix telling the player they are losing.
 */
const PLAYER_DAMAGE_IMPORTANCE = -3;
/** A swing that cut air. It happened, and almost nothing about it matters. */
const WHIFF_IMPORTANCE = -20;
/**
 * The interface, which is not part of the run's dynamic range but shares its bus. High
 * enough that nothing in a fight can cull a menu acknowledgement, low enough that opening
 * a menu does not shut the mix down behind it.
 */
const UI_IMPORTANCE = -4;

/**
 * The mechanical layer: the bolt, the hammer and the casing.
 *
 * The standard AAA gunshot is five layers, not three -- body, transient, sub, mechanical
 * and tail -- and this was the missing one. It is what makes a gun sound like a *machine*
 * rather than an event: two band-limited clicks, one on the shot and one a bolt-throw
 * later, randomised in pitch and level per event so a held trigger does not machine-gun
 * one waveform.
 *
 * It is also the only layer that differs per chassis, which is the first time fitting the
 * gun at the bench has been audible at all. The numbers are the ones the chassis already
 * states in its handling: a shotgun's action is slow, heavy and low, an SMG's is light and
 * quick, and the DMR's is the longest throw in the game.
 */
const MECHANICAL: Record<WeaponChassisId, { hammerHz: number; boltHz: number; boltSeconds: number; gain: number }> = {
  carbine: { hammerHz: 1500, boltHz: 1060, boltSeconds: 0.052, gain: 0.017 },
  smg: { hammerHz: 1850, boltHz: 1320, boltSeconds: 0.04, gain: 0.013 },
  shotgun: { hammerHz: 980, boltHz: 720, boltSeconds: 0.086, gain: 0.026 },
  dmr: { hammerHz: 1340, boltHz: 880, boltSeconds: 0.07, gain: 0.022 },
};

/**
 * Threat, and the mix as a gameplay signal rather than a soundtrack to one.
 *
 * Blizzard bucket enemies by whether they are looking at you and how close they are, then
 * drive level off the bucket -- an enemy in the top bucket is about seven decibels over
 * the same enemy in the third. Our `placement` knew distance and bearing and nothing at
 * all about intent, which is the one thing the player needs from eight hostiles at once.
 *
 * The simulation already computes the missing term: a bot has a firing arc it must have
 * the player inside before it will commit. Facing is therefore the honest reading of
 * "about to shoot you", and it works inverted too -- a hostile pointed away from the
 * player is the thing to spend the range on rather than the thing to hear.
 */
const THREAT = {
  /** Cosine of the half-angle inside which a hostile counts as looking at the player. */
  aimedCosine: 0.72,
  /** Distance at which proximity stops adding to the reading. */
  nearMetres: 20,
  /** Level a fully-aimed hostile and an oblivious one are played at. */
  aimedGain: 1.5,
  ambientGain: 0.68,
  /** Decibels of priority a fully-aimed hostile gains in the window. */
  importanceLift: 6,
} as const;

/**
 * Resting level of the bus everything passes through, and the level a duck returns to.
 *
 * **This number was set by a measurement rather than by ear**, which is the first time
 * anything in this file has been. At 0.75 the mix rendered a representative fight at
 * -31.6 LUFS against an industry target of -23, with true peak at -12.5 dBFS against a
 * ceiling of -1: eight decibels quiet and eleven decibels of headroom thrown away. The
 * symptom a player would have reported is that this game is quieter than everything else
 * on their machine and the volume slider does not have the range to fix it.
 *
 * The raise is a pure level change and deliberately not a change of character. The
 * limiter's threshold moves by the same amount (see `createLimiter`), so the mix is
 * compressed exactly as much as it was before -- what changed is where it sits, not what
 * it does. `tests/mixLoudness.test.ts` pins the result, so the next move on this number is
 * as deliberate as this one.
 */
const BUS_LEVEL = 1.9;
/**
 * Decibels the level was raised by, named once so the limiter can follow it. Changing
 * `BUS_LEVEL` without changing this turns a level decision into a compression decision.
 */
const MIX_TRIM_DB = 20 * Math.log10(1.9 / 0.75);
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
 * The two rooms this route is actually made of.
 *
 * There was one generated impulse response with three fixed send levels, which is a single
 * room for the whole game -- and the route is a bunker corridor *and* an open rooftop deck.
 * The five-layer weapon this mix was missing two of got its mechanical layer last pass;
 * this is the other one. The tail is the layer that says where a sound happened, and it
 * cannot say two things at once with one impulse.
 *
 * Both are long and heavily damped relative to what a physical model would give: an
 * undamped noise decay is a hiss, which is the last thing a low-register mix wants sitting
 * on top of it, and the one-pole coefficient rolls the reflections off so what comes back
 * is body rather than air. The difference between them is the whole point:
 *
 * - **Interior** is short and dark. A corridor returns quickly and returns almost nothing
 *   above the low mids, which is what makes a space feel like it has a ceiling.
 * - **Exterior** is nearly three times as long and considerably brighter, because an open
 *   deck between towers is a set of distant hard surfaces rather than a close soft one.
 */
const ROOMS = {
  interior: { seconds: 0.85, decay: 3.6, damping: 0.055 },
  exterior: { seconds: 2.6, decay: 2.3, damping: 0.17 },
} as const;

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
 * The key, and this is the change that makes the difference between a set of cues and
 * a mix.
 *
 * Every pitch in this file used to be an arbitrary number that sounded right on its own,
 * which is exactly why two cues landing together sounded like two cues landing together:
 * a kill at 104 Hz over a chain tone at 68 is a minor sixth *and a bit*, and the bit is
 * what the ear hears. Nothing is picked in Hz any more. There is a root -- 34 Hz, which
 * is the bed's own floor, because the floor is the one thing always sounding and so it is
 * the only honest place to put the tonic -- and every tonal layer in the game is an
 * interval over it.
 *
 * The ratios are just rather than tempered on purpose. A mix this low is mostly harmonics
 * of harmonics: at 34 Hz the fundamental is below what a laptop speaker can move and what
 * the player actually hears is the series the drive stage generates. Small integer ratios
 * put those series on top of each other; a tempered fifth at 1.4983 puts them two cents
 * apart, which at these register is an audible beat rather than a chord.
 *
 * The register statement from the last pass is unchanged: nothing tonal starts above
 * 200 Hz, and the interface still sits above the run rather than inside it.
 */
const KEY_HZ = 34;

const INTERVAL = {
  root: 1,
  /**
   * The sour one, and it is reserved. Everything that happens *to* the player -- a
   * telegraph, a hit taken, a wave arriving, a chain breaking -- is built on the flat
   * second, so it beats against the floor the whole mix is sitting on. Everything the
   * player *does* is consonant. That is the one rule in this table, and it means the mix
   * says which direction a transaction went before it says anything else about it.
   */
  minorSecond: 16 / 15,
  minorThird: 6 / 5,
  fourth: 4 / 3,
  fifth: 3 / 2,
  minorSixth: 8 / 5,
  minorSeventh: 9 / 5,
} as const;

type Interval = keyof typeof INTERVAL;

/**
 * The key, published for the one test that can hold this whole design: that every tonal
 * layer in the game is a degree of it. Nothing reads this at runtime -- it is the mix's
 * own statement of what it is built from, and the only way to guard a rule that is
 * otherwise a hundred numbers scattered through one file.
 */
export const mixKey = { rootHz: KEY_HZ, intervals: INTERVAL } as const;

/** A pitch in the key: `interval`, `octaves` above the root. Negative octaves go under it. */
function note(interval: Interval, octaves = 0): number {
  return KEY_HZ * INTERVAL[interval] * 2 ** octaves;
}

/**
 * The scale a chain climbs, a degree per link.
 *
 * Two octaves and a bit, and then it holds. A chain can run to sixteen links and beyond;
 * a scale that kept climbing would put the style meter in the beep register it took a
 * whole pass to get out of, and a chain that gets *shriller* the better it goes is the
 * opposite of the read. Plateauing is also a fair statement about a long chain: the
 * climbing stops, and what is left is the weight the bed has picked up underneath it.
 */
const CHAIN_SCALE: readonly number[] = [
  ...([0, 1] as const).flatMap((octave) =>
    (['root', 'minorThird', 'fourth', 'fifth', 'minorSixth', 'minorSeventh'] as const).map((interval) => note(interval, octave))),
  note('root', 2),
  note('minorThird', 2),
];

/**
 * What a live chain does to the mix.
 *
 * The chain is the style meter and until now the mix said one thing about it: a tone per
 * link. It should be audible that a chain is *live* -- and the shape of that has to be
 * continuous rather than eventful, for the same reason `comboScoring.flourishFromLink`
 * exists. A full-frame effect that fires constantly is decoration; a *sound* that fires
 * constantly is worse, because the player cannot look away from it. So nothing here is a
 * new cue. Everything is a target the bed is already following at
 * `BED.followSeconds`: the floor climbs the scale, a harmonic opens over it, the room
 * gets wetter and the movement layer brightens. A player who chains well hears the room
 * change; a player who drops the chain hears it relax over the best part of a second.
 */
const CHAIN = {
  /** Links at which the chain's effect on the mix is fully open. The S-rank gate. */
  fullLinks: 8,
  /** Links per scale degree the floor climbs. */
  linksPerDegree: 3,
  /** Degrees it may climb. Four puts an eight-link chain a fifth over the tonic. */
  maxDegrees: 4,
  /** Extra floor level at a full chain, as a fraction of the level it would have had. */
  floorLift: 0.55,
  /**
   * The harmonic that opens over the floor. A tenth above the tonic -- the colour note --
   * so a live chain is the only time the bed is a chord rather than a fifth. Its level is
   * under the floor's, because it is meant to be noticed on the way in and not stared at.
   */
  harmonicHz: note('minorThird', 1),
  harmonicGain: 0.024,
  /** How much further into the room a full chain pushes both reverb sends. */
  sendLift: 0.5,
  /**
   * Window fraction the colour note starts fading at. The same 0.34 the HUD's combo
   * readout switches to its `lapsing` state on, deliberately: one threshold, said in two
   * places, rather than the mix and the frame disagreeing about when a chain is in
   * trouble. It fades the harmonic only -- the floor it climbed to stays, because losing
   * the chain is what takes that away and it should be the *drop* that lands.
   */
  lapseFrom: 0.34,
  /** Extra cutoff on the movement layer at a full chain, in Hz. */
  driveOpen: 130,
} as const;

/**
 * The pulse, and it is the one thing in this mix that keeps time.
 *
 * The bed is vertical remixing -- layers fading in and out on a gameplay parameter -- and
 * it has no concept of *time*: there is no pulse anywhere in this game, which is most of
 * the distance between what the mix is and what a player would call a soundtrack. This is
 * a slow gated blip on eighths, keyed to how live the room is, and it stops when the room
 * is cleared.
 *
 * Three things about it are deliberate. It is not scheduled: a held oscillator drives the
 * layer's own gain through a shaper, so the gate exists in the graph rather than in a
 * queue of future events -- which is what keeps it from drifting and what keeps it out of
 * the way of the one thing that must never be quantised, which is a gameplay cue arriving
 * the instant it happened. It is filtered noise rather than a note, so it cannot disagree
 * with a bed that transposes up the scale under a live chain. And it is quiet enough to be
 * a floor rather than a part: a pulse you notice is a pulse you mute.
 */
const PULSE = {
  bpm: 96,
  /** Beats subdivided this far. Two is eighths. */
  division: 2,
  /** Where the blip sits. A muted fifth, two octaves up, as a band rather than a note. */
  hz: note('fifth', 2),
  q: 3.4,
  /**
   * Gate sharpness: the exponent a sine is raised to on its way to the gain. Twelve turns
   * a smooth cycle into about a fifth of it sounding, which is a pulse rather than a
   * tremolo.
   */
  shape: 12,
  /** Level at a full room, and the hostiles that count as one. */
  gainFull: 0.019,
  threatFull: 4,
  /** How much a live chain opens the pulse's band, in Hz. */
  chainOpen: 90,
} as const;

/**
 * What each blade sounds like.
 *
 * `content/blades.ts` gives Tempo, Cleave and Riposte different reach, recovery and chain
 * rules, and until now they sounded identical -- which is a strange thing for the primary
 * verb, and the one place in the game where a choice the player made was completely
 * inaudible. The differences here are the same differences the tuning already states, in
 * the only three terms a synthesised impact has: **how low**, **how long** and **how
 * bright**.
 *
 * - **Tempo** is the reference, on the root.
 * - **Cleave** is lower, longer and darker: it recovers in 0.30 s where Tempo takes 0.24,
 *   hits for 82, and takes a wider bite. It lands on the flat seventh, which is the
 *   heaviest consonance in the table.
 * - **Riposte** is higher, shorter and brighter, because it is 0.19 s of recovery and 52
 *   damage -- a blade that is *quick* has to sound quick, and length is the only way a
 *   sub says so. It sits on the minor third.
 *
 * Every heavy is a fourth or a fifth under its own light and carries a second sub an
 * octave over that, which is the trick the kill uses: a swing that moved the room.
 */
/**
 * One of a blade's two edges.
 *
 * The round robin, and the reason it is spelled out in three numbers rather than one.
 * The rule of thumb is that anything heard more than twice needs varying, and the blade is
 * the primary verb -- but the knob this file was varying was **pitch**, which is the least
 * audible thing about a five-millisecond transient. Two per cent of 1200 Hz is nothing.
 * What is audible at that length is how long it rings and how narrow the band is, so the
 * two edges differ in all three and the pair alternates per swing.
 */
interface BladeEdge {
  hz: number;
  /** Filter Q. A wider band is a scrape; a narrow one is a ring. */
  q: number;
  seconds: number;
}

interface BladeVoice {
  light: { hz: number; seconds: number; gain: number };
  heavy: { hz: number; seconds: number; gain: number };
  /** The body under the cut -- a bent sine, the layer that says what the blade is. */
  bodyHz: number;
  /**
   * The two edges, alternating per swing. Brightness is most of a blade's character and
   * the alternation is what stops two consecutive cuts being one recording played twice.
   */
  edges: readonly [BladeEdge, BladeEdge];
  /** The whiff: dark air, and how long the player just committed for. */
  airHz: number;
  airSeconds: number;
}

const BLADE_VOICE: Record<BladeStyleId, BladeVoice> = {
  tempo: {
    light: { hz: note('root', 1), seconds: 0.34, gain: 0.15 },
    heavy: { hz: note('fifth', 0), seconds: 0.55, gain: 0.17 },
    bodyHz: note('fifth', 1),
    edges: [{ hz: 1200, q: 1.4, seconds: 0.005 }, { hz: 970, q: 2.7, seconds: 0.0075 }],
    airHz: 700,
    airSeconds: 0.16,
  },
  cleave: {
    light: { hz: note('minorSeventh', 0), seconds: 0.44, gain: 0.17 },
    heavy: { hz: note('fourth', 0), seconds: 0.62, gain: 0.19 },
    bodyHz: note('fourth', 1),
    edges: [{ hz: 900, q: 1.2, seconds: 0.006 }, { hz: 745, q: 2.2, seconds: 0.0095 }],
    airHz: 560,
    airSeconds: 0.22,
  },
  riposte: {
    light: { hz: note('minorThird', 1), seconds: 0.24, gain: 0.13 },
    heavy: { hz: note('minorSixth', 0), seconds: 0.46, gain: 0.15 },
    bodyHz: note('minorSeventh', 1),
    edges: [{ hz: 1500, q: 1.6, seconds: 0.004 }, { hz: 1245, q: 3.1, seconds: 0.006 }],
    airHz: 860,
    airSeconds: 0.12,
  },
};

/**
 * What a hostile is made of, and it is three sounds rather than three levels.
 *
 * The simulation already treats these as three different problems -- a hunter shoots from
 * eighteen metres, a brawler closes inside the blade's reach, a bulwark walks a plate at
 * you -- and the mix knew about exactly one of them, through `deflected`. A plate should
 * ring. A brawler at arm's length should be the meatiest thing the player hits. A hunter
 * is the reference.
 */
const MATERIAL = {
  ranged: { bodyHz: 220, edgeHz: 1100, weight: 1, ring: false },
  /** Closest, densest and the one the player hits most in a crowd. */
  aggressive: { bodyHz: 170, edgeHz: 900, weight: 1.12, ring: false },
  /** Steel. The ring is what makes it plate rather than a quieter hit. */
  bulwark: { bodyHz: 300, edgeHz: 1500, weight: 0.9, ring: true },
} as const satisfies Record<BotProfile['kind'], { bodyHz: number; edgeHz: number; weight: number; ring: boolean }>;

type Material = typeof MATERIAL[keyof typeof MATERIAL];

/** Everything that happened to one hostile inside a single batch of events. */
interface TargetOutcome {
  killed: boolean;
  /** Which swing reached it, or null if it was a round. */
  blade: 'light' | 'heavy' | null;
  deflected: boolean;
}

/**
 * The plate's ring. Deliberately just under the kilohertz the register rule guards, with
 * a narrow band and a long decay for something that is otherwise all transient: a struck
 * plate is the one thing in this game that keeps sounding after it is hit.
 */
const PLATE_RING = { hz: 820, q: 9, seconds: 0.12, gain: 0.03 } as const;

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
  /** The crossfade between the two rooms. See `ROOMS` and `AudioSustainState.space`. */
  private interiorSend: GainNode | null = null;
  private exteriorSend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** Saturation curve for the low end, built once. Null where `WaveShaperNode` is absent. */
  private driveCurve: Float32Array<ArrayBuffer> | null = null;
  /** Context time the current duck finishes at. A new one is refused before then. */
  private duckUntil = 0;
  /** The bed's layers. Built with the graph, silent until `sustain` asks for them. */
  private floorGain: GainNode | null = null;
  /**
   * The floor's oscillators and the interval each one sits at, so a live chain can
   * transpose the whole bed up the scale without rebuilding it. An oscillator cannot be
   * restarted once stopped, so moving the existing ones is the only option anyway.
   */
  private floorVoices: { oscillator: OscillatorNode; ratio: number }[] = [];
  /** The colour note a live chain opens over the floor. Silent at zero links. */
  private harmonicGain: GainNode | null = null;
  private driveGain: GainNode | null = null;
  private driveFilter: BiquadFilterNode | null = null;
  /** The pulse's layer and the depth its gate is applied at. */
  private pulseGain: GainNode | null = null;
  private pulseDepth: GainNode | null = null;
  private pulseFilter: BiquadFilterNode | null = null;
  /** Base levels of the two sends, so a chain can lift them and let them back down. */
  private sendLevels = { near: 0.17, far: 0.44 };
  /** Which blade is in the player's hands. The reference style until told otherwise. */
  private bladeVoice: BladeVoice = BLADE_VOICE.tempo;
  /** Which gun is in the player's hands, for the mechanical layer. */
  private mechanism = MECHANICAL.carbine;
  /**
   * Which of the blade's two edges the next swing takes.
   *
   * A counter rather than a hash of the event id, because the point is that consecutive
   * swings *alternate* and ids do not: other events are interleaved between two cuts, so
   * their parity is arbitrary. It is still deterministic for a given event stream, which
   * is the rule the rest of the variation in this file follows.
   *
   * Nothing in the renderer alternates per swing for this to disagree with -- the
   * viewmodel's two swing curves are light against heavy, not first against second -- so
   * this is the only alternation in the game and cannot desync from another one.
   */
  private swingRobin = 0;
  /**
   * Where the cue being built is scheduled, as an offset from `currentTime`.
   *
   * `consume` is called once per *rendered* frame with the events of up to five
   * simulation steps, and every voice used to be scheduled at `currentTime` -- so a hit
   * that happened on the first of five steps played up to 83 ms late and *simultaneously*
   * with a hit from the fifth. Every event carries the tick it happened on and the step is
   * a fixed 1/60 s, so the offset is exact: a burst arrives as a rhythm instead of as a
   * cluster. Distance is folded in here too, because the two are the same thing -- a cue
   * is late by when it happened plus how far away it happened.
   */
  private scheduleAt = 0;
  /** What the cue being built is worth, in the units `CUE` is authored in. */
  private importance = 0;
  /** The top of the HDR window, and the scheduled time it was last written at. */
  private windowTop: number = HDR.restDb;
  private windowAt = 0;
  /** Voices sounding right now, counted so the window can tighten under pressure. */
  private liveVoices = 0;

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
      this.interiorSend = null;
      this.exteriorSend = null;
    }
  }

  /**
   * Which blade the player carries. Read from the save and set once per run, because the
   * blade is the primary verb and the three styles sounded identical.
   */
  setBladeStyle(style: BladeStyleId | undefined): void {
    this.bladeVoice = BLADE_VOICE[style ?? 'tempo'] ?? BLADE_VOICE.tempo;
  }

  /**
   * Which gun the player is holding, for the mechanical layer.
   *
   * Unlike the blade this can change inside a run -- there are two slots and a swap key --
   * so it is pushed every frame rather than once at construction, and the early-out is
   * what makes that free.
   */
  setWeaponChassis(chassis: WeaponChassisId | undefined): void {
    const next = MECHANICAL[chassis ?? 'carbine'] ?? MECHANICAL.carbine;
    if (next !== this.mechanism) this.mechanism = next;
  }

  consume(events: readonly GameEvent[], listener?: AudioListenerState): void {
    if (!this.context || this.context.state !== 'running') return;
    // What happened to each hostile across the whole batch, worked out before anything
    // is played. This is what lets one target produce one impact cue: a killing slash
    // arrives as a `melee`, a `hit` and a `kill` on the same tick, and playing all three
    // is three cues queueing rather than one event.
    const outcomes = batchOutcomes(events);
    // The tick this batch starts on. Everything after it is scheduled forward from here,
    // which is what turns five steps' worth of events from a cluster into a rhythm.
    let firstTick = Number.POSITIVE_INFINITY;
    for (const event of events) firstTick = Math.min(firstTick, event.tick);
    /** Instances of each cue already played in this batch. See `CUE.limit`. */
    const played = new Map<GameEvent['kind'], number>();
    for (const event of events) {
      const place = this.placement(event, listener);
      const policy = CUE[event.kind];
      const stacked = played.get(event.kind) ?? 0;
      played.set(event.kind, stacked + 1);
      if (policy?.limit !== undefined && stacked >= policy.limit) continue;
      this.scheduleAt = Math.max(0, (event.tick - firstTick) * STEP_SECONDS) + place.delay;
      this.importance = (policy?.importance ?? -12) + place.importanceLift;
      // Deterministic per-event variation. Presentation is allowed to be arbitrary but
      // it must not differ run to run, and without this a held trigger is a machine gun
      // of one identical waveform -- the most artificial thing a synth mix can do and
      // the cheapest to fix.
      const vary = variation(event.id, 0.055);
      // Tonal layers are detuned far less than the noise layers are. See `TONAL_SPREAD`:
      // a variation wider than the smallest interval in the key is not a variation, it
      // is a different note, and it was audibly one whenever two cues landed together.
      const detune = variation(event.id, TONAL_SPREAD);
      switch (event.kind) {
        case 'shot':
          // Sub first. The tick is five milliseconds of definition so the shot has an
          // edge; everything a player actually feels is under 200 Hz. Always centred
          // and always at full level -- it is the one sound that must never be masked.
          this.tick(1300 * vary, 0.005, 0.028, 0, 'dry');
          this.boom(190 * vary, 0.13, 0.11, 0, 'near');
          this.sub(note('minorSeventh', 0) * detune, 0.3, 0.13, 0.42, 0, 'dry');
          this.tone({ frequency: note('fourth', 1) * detune, duration: 0.16, gain: 0.05, type: 'sine', bend: 0.5, lowpass: 300 }, 0, 0, 'dry');
          // The layer that makes it a machine rather than an event, and the only one
          // that differs per chassis. See `MECHANICAL`.
          this.mechanical(event.id);
          break;
        case 'dryFire':
          // An empty chamber is the mechanical layer with nothing on top of it, which is
          // both what it is and the clearest possible statement that no round left.
          this.tick(this.mechanism.hammerHz, 0.006, 0.03, 0, 'dry');
          this.boom(260, 0.05, 0.03, 0, 'near');
          this.mechanical(event.id);
          break;
        case 'impact':
          // Body shots already get the confirm, so only surfaces tick here. Both layers
          // vary per event, so a shotgun pattern reads as debris rather than as the same
          // tick eight times.
          if (event.targetEntityId !== undefined) break;
          // Length as well as pitch: at four milliseconds the ear reads duration long
          // before it reads a two per cent detune, so a shotgun pattern varies where it
          // can actually be heard varying.
          this.boom(320 * vary * place.cutoffScale, 0.06 * vary, 0.04 * place.gain, place.pan, place.send);
          this.tick(1400 * vary, 0.004 * vary, 0.012 * place.gain * place.edge, place.pan, place.send, 1.4 * vary);
          break;
        case 'hit': {
          if (this.isPlayer(event.targetEntityId, listener)) {
            // Not the `hit` cue and not worth what a `hit` is worth: this is the mix
            // telling the player they are losing, and nothing else in a batch outranks it.
            this.importance = PLAYER_DAMAGE_IMPORTANCE;
            this.playerDamaged(event.value ?? 0);
            break;
          }
          const outcome = event.targetEntityId === undefined ? undefined : outcomes.get(event.targetEntityId);
          // One target, one impact cue. Whatever else happened to this hostile on this
          // tick owns the confirm: a kill folds it in, and so does a cut. Before this, a
          // killing slash played a cut, a confirm *and* a kill -- three cues for one
          // event, which is what "the cues queue rather than combine" meant in practice.
          if (outcome?.killed || outcome?.blade) break;
          const material = materialOf(event.targetEntityId, listener);
          if (event.deflected) {
            // A shot the plate ate is a dull, dead thud with no sub under it: the player
            // should hear that they connected and that it did not count. Taking the
            // weight away is a clearer statement than turning the volume down -- and what
            // is left is the plate itself, which is the thing to go around.
            this.boom(material.bodyHz * 0.68, 0.07, 0.05, 0, 'near');
            this.ring(0, 'near');
          } else {
            // The confirm is a thud, not a blip, and how dense the thud is belongs to
            // what was hit. A headshot's sub sits a fifth higher and its edge is
            // brighter, so precision is audible without either leaving the register.
            this.sub(
              event.headshot ? note('minorSeventh', 1) : note('minorThird', 1),
              event.headshot ? 0.13 : 0.11,
              (event.headshot ? 0.06 : 0.055) * material.weight,
              0.58, 0, 'dry',
            );
            this.tick(event.headshot ? material.edgeHz * 1.45 : material.edgeHz, 0.004, event.headshot ? 0.022 : 0.016, 0, 'dry');
          }
          break;
        }
        case 'kill': {
          const outcome = event.targetEntityId === undefined ? undefined : outcomes.get(event.targetEntityId);
          const material = materialOf(event.targetEntityId, listener);
          if (stacked > 0) {
            // A second body on the same tick answers the first a fourth up rather than
            // repeating it. No duck: the first kill already took the mix down, and a
            // second one inside it would be refused anyway.
            this.tick(material.edgeHz * 1.2, 0.005, 0.024, 0, 'dry');
            this.sub(note('root', 2), 0.3, 0.09 * material.weight, 0.3, 0, 'near');
            if (material.ring) this.ring(0, 'far');
            break;
          }
          // The biggest moment in the loop, and the only cue with two subs an octave
          // apart: the upper one is the impact, the lower one is what is left of it. They
          // sit on the fifth -- the interval the bed itself is built from -- so a kill
          // reads as the mix resolving rather than as another note arriving over it.
          // Plus the longest tail in the mix and the duck that clears room for it.
          this.duck(outcome?.blade ? 0.62 : 0.58, 0.34);
          // The killing blow's own transient, at the brightness of whatever delivered it:
          // the blade's edge for a cut, the material's for a round. This is the
          // combining -- a killing slash is one impact in the mix, not a cut and then a
          // kill, and the sub below is longer than the cut's own would have been.
          // The killing blow's edge is the one the swing that delivered it was already
          // going to use, so a finishing cut is the same blade rather than a brighter one.
          const finish = this.bladeVoice.edges[this.swingRobin % this.bladeVoice.edges.length];
          this.tick(
            outcome?.blade ? finish.hz * 1.25 : material.edgeHz * 1.36,
            outcome?.blade ? finish.seconds * 1.3 : 0.006,
            0.03, 0, 'dry',
            outcome?.blade ? finish.q : 1.4,
          );
          this.sub(note('fifth', 1), outcome?.blade === 'heavy' ? 0.7 : 0.62, 0.16 * material.weight, 0.24, 0, 'near');
          this.sub(note('fifth', 0), 0.5, 0.1, 0.5, 0, 'near');
          this.boom(material.bodyHz * 0.68, 0.4, 0.09, 0, 'far');
          // Steel going down on a deck keeps sounding after the body has stopped.
          if (material.ring) this.ring(0, 'far');
          break;
        }
        case 'heal': {
          // The only cue in the game that gives something back, and deliberately the
          // quietest thing the player can earn. It rises where damage taken falls, it is
          // the fifth -- the consonance the bed is built from, because being paid for
          // aggression is the mix agreeing with the player -- and it does not duck: the
          // kill that caused it ducked on the same tick, and two punctuation marks on one
          // event is pumping rather than emphasis.
          const share = Math.min(1, Math.max(0.2, (event.value ?? 0) / lifesteal.maxPerKill));
          this.sub(note('fifth', 0), 0.28, 0.045 * share, 2, 0, 'near');
          this.tone({ frequency: note('fifth', 1), duration: 0.22, gain: 0.03 * share, type: 'triangle', bend: 1.5, lowpass: 340 }, 0.02, 0, 'near');
          break;
        }
        case 'melee': {
          // A swing that connected and a swing that cut air are different sounds, not
          // the same sound at two levels. The whiff is dark air and nothing else; the
          // cut is the heaviest sub in ordinary play. This is the primary verb, so it is
          // the cue the player hears most and the one that most has to have weight --
          // and which blade is in their hands is audible in all three of the terms a
          // synthesised impact has. See `BLADE_VOICE`.
          const blade = this.bladeVoice;
          const swing = event.heavy ? blade.heavy : blade.light;
          if (event.targetEntityId === undefined) {
            // A heavy that cut air is a longer, lower rush of nothing than a light one:
            // the whiff should tell the player how much they just committed, and Cleave's
            // says more than Riposte's. It is also the least important thing the player
            // can cause, and the first of their own cues the window should take away.
            this.importance = WHIFF_IMPORTANCE;
            this.boom(
              (event.heavy ? blade.airHz * 0.74 : blade.airHz) * vary,
              (event.heavy ? blade.airSeconds * 1.62 : blade.airSeconds) * vary,
              0.04, 0, 'near',
            );
            break;
          }
          const outcome = outcomes.get(event.targetEntityId);
          const material = materialOf(event.targetEntityId, listener);
          // The edge and the body always sound: the player has to hear that the blade
          // connected however the exchange ended, and the body is what it connected with.
          // The round robin, and the only place it advances: one swing, one edge.
          const edge = this.nextEdge();
          this.tick(edge.hz * vary, edge.seconds * vary, event.heavy ? 0.032 : 0.03, 0, 'dry', edge.q);
          this.boom(material.bodyHz * vary, event.heavy ? 0.3 : 0.14, (event.heavy ? 0.12 : 0.1) * material.weight, 0, 'near');
          // A plate rings and does not part. What is missing is the weight, which is the
          // cue to get around it rather than keep swinging at it.
          if (outcome?.deflected) {
            this.ring(0, 'near');
            break;
          }
          // A killing blow is not a cut and then a kill. The weight of this one belongs
          // to the `kill` cue in the same batch, which carries the blade's own edge.
          if (outcome?.killed) break;
          // The heavy is the only impact with a second sub an octave up -- the same trick
          // the kill uses, because a heavy that lands on three hostiles moved the room.
          this.sub(swing.hz * detune, swing.seconds, swing.gain * material.weight, event.heavy ? 0.34 : 0.38, 0, 'near');
          if (event.heavy) this.sub(swing.hz * 2 * detune, swing.seconds * 0.44, swing.gain * 0.59, 0.4, 0, 'far');
          this.tone({
            frequency: blade.bodyHz * detune,
            duration: event.heavy ? 0.26 : 0.14,
            gain: event.heavy ? 0.06 : 0.055,
            type: 'sine',
            bend: event.heavy ? 0.42 : 0.45,
            lowpass: event.heavy ? 220 : 260,
          }, 0, 0, 'dry');
          break;
        }
        case 'enemyTelegraph': {
          // The single most important cue in the mix: it is the only warning the player
          // gets before taking damage. It used to be a rising square in the upper mids,
          // which is alarming in the way an alarm clock is. Now it is pressure -- a low
          // swell rising through the wind-up, placed, with one tick at the front so the
          // player can tell where it came from.
          const windup = Math.max(0.12, event.value ?? 0.3);
          this.tick(1500, 0.005, 0.014 * place.gain * place.edge, place.pan, 'dry');
          this.sub(note('fourth', 0), windup, 0.075 * place.gain, 2.6, place.pan, 'near');
          // The flat second, which is the interval this mix keeps for things that are
          // about to happen *to* the player: it beats against the floor the room is
          // sitting on, so the warning is dissonance rather than volume.
          this.tone({ frequency: note('minorSecond', 2), duration: windup, gain: 0.05 * place.gain, type: 'triangle', bend: 1.9, lowpass: 420 }, 0, place.pan, 'dry');
          break;
        }
        case 'enemyAttack':
          // Duller and lower than the player's own shot so the two never blur, and
          // wetter, because it happens out there rather than in their hands.
          this.boom(200 * place.cutoffScale, 0.1, 0.085 * place.gain, place.pan, place.send);
          this.sub(note('fourth', 0), 0.22, 0.075 * place.gain, 0.6, place.pan, 'far');
          this.tone({ frequency: note('minorSecond', 1), duration: 0.1, gain: 0.05 * place.gain, type: 'sine', bend: 0.5, lowpass: 220 }, 0, place.pan, 'dry');
          break;
        case 'death':
          // The lowest and longest thing in the game, and the deepest duck. Everything
          // else stops mattering, and the mix says so by nearly stopping.
          this.duck(0.8, 0.9);
          this.sub(note('minorSeventh', 0), 1.5, 0.16, 0.42, 0, 'far');
          this.sub(note('minorSeventh', -1), 1.2, 0.1, 0.7, 0, 'far');
          this.boom(110, 0.9, 0.12, 0, 'far');
          break;
        case 'respawn':
          // Rises where death fell, so redeploying reads as the inverse of going down.
          // Starts on the flat second and *resolves* onto the fifth two octaves up,
          // which is the only voice in the mix that leaves the dissonance behind it.
          this.sub(note('minorSecond', 0), 0.45, 0.1, 2.81, 0, 'near');
          this.tone({ frequency: note('fourth', 1), duration: 0.3, gain: 0.06, type: 'triangle', bend: 2, lowpass: 300 }, 0, 0, 'near');
          break;
        case 'comboLink': {
          // A degree of the scale per link, so a chain is audible as a phrase rather than
          // as a rising number -- and every link lands *in the key* the bed is holding
          // underneath it, which is the whole reason the key exists. It climbs from the
          // tonic rather than from 520 Hz, so a long chain gets heavier before it gets
          // higher, and it plateaus rather than climbing into the beep register.
          const step = Math.max(1, Math.round(event.value ?? 1));
          this.sub(CHAIN_SCALE[Math.min(CHAIN_SCALE.length - 1, step - 1)], 0.1, 0.06, 1.15, 0, 'near');
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
          // Two octaves in a third of a second, from the fifth to the fifth: the only
          // voice in the mix that travels that far, and it lands somewhere the bed
          // already agrees with, which is what makes it read as an answer.
          this.sub(note('fifth', 0), 0.34, 0.15, 4, 0, 'near');
          this.boom(320, 0.2, 0.07, 0, 'far');
          this.tone({ frequency: note('minorThird', 2), duration: 0.22, gain: 0.05, type: 'triangle', bend: 2.4, lowpass: 520 }, 0, 0, 'far');
          break;
        case 'comboBreak':
          // Falls, and onto the flat second: a chain lapsing is something that happened
          // to the player, so it sits with the telegraph and the hit rather than with
          // the links it just lost.
          this.sub(note('minorSecond', 1), 0.3, 0.07, 0.42, 0, 'near');
          break;
        case 'split':
          this.sub(note('minorThird', 1), 0.16, 0.06, 1.5, 0, 'near');
          this.tick(1400, 0.005, 0.018, 0, 'near');
          break;
        case 'reloadStart':
          // The magazine leaving, at the chassis's own pitch: the bench is audible in the
          // reload as well as in the shot, which is where a player actually listens to it.
          this.tick(this.mechanism.boltHz, 0.006, 0.03, 0, 'dry');
          this.boom(340, 0.05, 0.035, 0, 'dry');
          break;
        case 'reloadComplete':
          this.tick(this.mechanism.hammerHz, 0.005, 0.032, 0, 'dry');
          this.boom(240, 0.06, 0.045, 0, 'dry');
          this.sub(note('fourth', 1), 0.08, 0.04, 0.8, 0, 'dry');
          // The bolt going home, which is the sound a reload actually ends on.
          this.mechanical(event.id);
          break;
        case 'checkpoint':
          this.sub(note('minorSeventh', 0), 0.5, 0.09, 1.6, 0, 'near');
          this.tone({ frequency: note('minorSeventh', 1), duration: 0.35, gain: 0.05, type: 'sine', lowpass: 320 }, 0, 0, 'far');
          break;
        case 'complete':
          this.duck(0.42, 0.5);
          // The fifth, its octave, and then the root above both: the run resolving onto
          // the note the bed has been holding under it for the whole of it.
          this.sub(note('fifth', 0), 0.9, 0.12, 1.5, 0, 'far');
          this.tone({ frequency: note('fifth', 1), duration: 0.6, gain: 0.06, type: 'sine', lowpass: 300 }, 0, 0, 'far');
          this.tone({ frequency: note('root', 2), duration: 0.5, gain: 0.04, type: 'sine', lowpass: 380 }, 0.18, 0, 'far');
          break;
        case 'wave':
          // A room that is not finished with you. Long, low and rising, deliberately
          // close to the gate's swell -- both mean the geometry of the fight just
          // changed -- but shorter, and with a tick so it lands rather than looms.
          this.tick(1000, 0.006, 0.026, 0, 'near');
          this.sub(note('minorSecond', 0), 0.85, 0.12, 2.4, 0, 'far');
          this.boom(140, 0.5, 0.08, 0, 'far');
          break;
        case 'gateOpen':
          // A thirty-metre door. The sub is the entire point of it.
          this.sub(note('minorSeventh', -1), 1.1, 0.13 * place.gain, 2.2, place.pan, 'far');
          this.boom(120 * place.cutoffScale, 0.8, 0.09 * place.gain, place.pan, 'far');
          break;
        case 'grappleAttach':
          this.tick(1700, 0.005, 0.028, 0, 'dry');
          this.sub(note('fourth', 1), 0.14, 0.07, 0.7, 0, 'near');
          break;
        case 'grapplePull':
          this.sub(note('minorThird', 1), 0.12, 0.075, 1.5, 0, 'near');
          break;
        case 'grappleRelease':
          this.sub(note('root', 1), 0.1, 0.045, 0.7, 0, 'near');
          break;
        case 'grappleFail':
          this.boom(180, 0.05, 0.03, 0, 'dry');
          break;
        default:
          break;
      }
    }
    // Nothing outside a batch is placed or ranked. Left set, the last event of a frame
    // would silently schedule the next thing the interface plays.
    this.scheduleAt = 0;
    this.importance = 0;
  }

  /**
   * The mechanical layer: two band-limited clicks, one on the shot and one a bolt-throw
   * after it, both randomised per event so a held trigger is not one waveform repeating.
   *
   * Deliberately the quietest layer of the five and deliberately the only one that knows
   * which gun this is. See `MECHANICAL`.
   */
  private mechanical(eventId: number): void {
    const machine = this.mechanism;
    // A wider spread than any tonal layer gets, because this is the layer whose whole
    // job is to sound imperfect. Noise has no pitch to be wrong about.
    const spread = variation(eventId, 0.09);
    const level = variation(eventId ^ 0x5bf0, 0.22);
    this.tick(machine.hammerHz * spread, 0.005, machine.gain * level, 0.12, 'dry');
    this.at(machine.boltSeconds * spread, () => {
      this.tick(machine.boltHz / spread, 0.007, machine.gain * 0.82 * level, -0.16, 'near');
    });
  }

  /** Runs `build` with everything it schedules pushed `seconds` further out. */
  private at(seconds: number, build: () => void): void {
    const base = this.scheduleAt;
    this.scheduleAt = base + seconds;
    build();
    this.scheduleAt = base;
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
    this.scheduleAt = 0;
    this.importance = UI_IMPORTANCE;
    switch (kind) {
      case 'hover':
        // Barely there. A menu that clicks loudly under the pointer is a menu the
        // player mutes, so this sits well under every other voice in the bus.
        this.tone({ frequency: note('fourth', 3), duration: 0.026, gain: 0.013, type: 'triangle', lowpass: 900 }, 0, 0, 'dry');
        break;
      case 'select':
        this.tick(1100, 0.006, 0.022, 0, 'dry');
        this.tone({ frequency: note('fifth', 2), duration: 0.035, gain: 0.024, type: 'square', lowpass: 700 }, 0, 0, 'dry');
        break;
      case 'confirm':
        // Rises a fifth. Square and lowpassed, so it cannot blur into the sine layer
        // the run is built from.
        this.tone({ frequency: note('minorSeventh', 2), duration: 0.07, gain: 0.05, type: 'square', lowpass: 640 }, 0, 0, 'dry');
        this.tone({ frequency: note('minorSeventh', 2) * INTERVAL.fifth, duration: 0.1, gain: 0.04, type: 'square', lowpass: 760 }, 0.06, 0, 'near');
        this.tick(1300, 0.005, 0.022, 0, 'dry');
        break;
      case 'cancel':
        // The inverse: one note, falling.
        this.tone({ frequency: note('minorSixth', 2), duration: 0.13, gain: 0.045, type: 'square', bend: 0.6, lowpass: 560 }, 0, 0, 'dry');
        break;
      case 'result': {
        // A stab under the rank landing, an octave and a half below where it used to
        // sit. Delayed so it does not land on top of the `complete` cue the run itself
        // just played, which is now nearly a second long.
        // The key's own triad, and the only place in the game it is stated plainly:
        // root, fifth, octave.
        const notes: readonly [number, number][] = [[note('root', 2), 0], [note('fifth', 2), 0.09], [note('root', 3), 0.18]];
        for (const [frequency, offset] of notes) {
          this.tone({ frequency, duration: 0.55 - offset, gain: 0.05, type: 'square', lowpass: 620 }, RESULT_STINGER_DELAY + offset, 0, 'far');
        }
        // A root under the stab. A tone rather than a sub, because `sub` takes no delay
        // and would have fired at zero, straight over the tail of the `complete` cue
        // this whole thing is offset to avoid.
        this.tone({ frequency: note('root', 1), duration: 0.6, gain: 0.055, type: 'triangle', lowpass: 200 }, RESULT_STINGER_DELAY, 0, 'near');
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
    this.interiorSend = null;
    this.exteriorSend = null;
    this.noiseBuffer = null;
    this.driveCurve = null;
    this.floorGain = null;
    this.floorVoices = [];
    this.harmonicGain = null;
    this.driveGain = null;
    this.driveFilter = null;
    this.pulseGain = null;
    this.pulseDepth = null;
    this.pulseFilter = null;
    this.duckUntil = 0;
    this.liveVoices = 0;
    this.windowTop = HDR.restDb;
    this.windowAt = 0;
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
    // The flat second under a minor third, both falling: the sourest pair in the table,
    // against a bed holding a root and a fifth. Nothing else in the mix rubs like this.
    this.sub(note('minorSecond', 1), 0.42, 0.15 * weight, 0.5, 0, 'near');
    this.boom(150, 0.2, 0.11 * weight, 0, 'near');
    this.tone({ frequency: note('minorThird', 1), duration: 0.28, gain: 0.07 * weight, type: 'sine', bend: 0.4, lowpass: 240 }, 0, 0, 'dry');
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
    const now = this.startTime();
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
  private placement(event: GameEvent, listener?: AudioListenerState): Placement {
    const source = event.origin ?? event.position;
    if (!listener || !source) return HERE;
    const dx = source[0] - listener.position[0];
    const dy = source[1] - listener.position[1];
    const dz = source[2] - listener.position[2];
    const distance = Math.hypot(dx, dy, dz);
    // Intent is read from the hostile rather than from the event, so it is the same
    // reading whether the cue is the telegraph or the shot that follows it.
    const threat = this.threatOf(event, listener);
    if (distance < 0.001) return { ...HERE, ...threat };
    // Matches the simulation's basis: forward is (-sin yaw, -cos yaw), so right is
    // (cos yaw, -sin yaw) and a positive dot puts the source to the player's right.
    const pan = (dx * Math.cos(listener.yaw) + dz * -Math.sin(listener.yaw)) / distance;
    const reach = Math.max(0, 1 - distance / MAX_AUDIBLE_METRES);
    return {
      gain: reach ** 1.4 * threat.gain,
      pan,
      send: distance > MAX_AUDIBLE_METRES * 0.3 ? 'far' : 'near',
      // Sound is slow. This is the whole of the distance cue that level cannot give.
      delay: distance / SPEED_OF_SOUND,
      cutoffScale: 1 / (1 + distance / AIR_ABSORPTION_METRES),
      // The edge goes first and goes fastest: a shot across the deck is a boom with
      // nothing on the front of it, which is exactly how the ear reads range.
      edge: reach ** EDGE_ROLLOFF,
      importanceLift: threat.importanceLift,
    };
  }

  /**
   * How much the player should care about whoever caused this event.
   *
   * Distance is already in `gain`; this is the term distance cannot give -- whether the
   * hostile is pointed at the player. A bot will not commit a shot until the player is
   * inside its firing arc, so facing is the honest reading of "about to hurt you", and
   * the same reading inverted is a cull: a marksman shooting down a corridor the player
   * left can go quiet without anything having to decide that it is unimportant.
   */
  private threatOf(event: GameEvent, listener: AudioListenerState): { gain: number; importanceLift: number } {
    const hostile = event.sourceEntityId === undefined ? undefined : listener.roster?.get(event.sourceEntityId);
    if (!hostile) return { gain: 1, importanceLift: 0 };
    const dx = listener.position[0] - hostile.position[0];
    const dz = listener.position[2] - hostile.position[2];
    const flat = Math.hypot(dx, dz);
    if (flat < 0.001) return { gain: THREAT.aimedGain, importanceLift: THREAT.importanceLift };
    // The simulation's forward for a facing of zero.
    const aimCosine = (-Math.sin(hostile.facing) * dx + -Math.cos(hostile.facing) * dz) / flat;
    const aimed = Math.max(0, (aimCosine - THREAT.aimedCosine) / (1 - THREAT.aimedCosine));
    const close = Math.max(0, 1 - flat / THREAT.nearMetres);
    // Facing carries most of it. A hostile at nine metres looking elsewhere is less
    // urgent than one at twenty about to fire, which is the whole point of the bucket.
    const weight = Math.min(1, aimed * (0.65 + 0.35 * close));
    return {
      gain: THREAT.ambientGain + (THREAT.aimedGain - THREAT.ambientGain) * weight,
      importanceLift: THREAT.importanceLift * weight,
    };
  }

  /**
   * The HDR window, and the one decision every voice in the run passes through.
   *
   * The window rises instantly to the loudest thing scheduled and falls back at a fixed
   * rate; anything more than `HDR.rangeDb` under it is not worth a voice and is not built.
   * The range tightens once the graph is already carrying a crowd, which is the voice
   * limit doing its real job: middleware ships playback limits and priorities so that the
   * loud and the important survive and everything else is culled *before* it is rendered,
   * and this graph tears down five nodes per cue.
   *
   * Evaluated at the time the voice is scheduled for rather than now, because after the
   * tick-accurate scheduling pass those are up to 83 ms apart.
   */
  private admit(when: number): boolean {
    const top = Math.max(HDR.restDb, this.windowTop - HDR.fallDbPerSecond * Math.max(0, when - this.windowAt));
    const range = this.liveVoices >= HDR.softVoices ? HDR.pressuredRangeDb : HDR.rangeDb;
    if (this.importance < top - range) return false;
    if (this.liveVoices >= HDR.hardVoices) return false;
    this.windowTop = Math.max(top, this.importance);
    this.windowAt = when;
    return true;
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
    // Two fixed send levels. See `Send` for why this is three states and not a knob.
    const near = context.createGain();
    near.gain.value = this.sendLevels.near;
    const far = context.createGain();
    far.gain.value = this.sendLevels.far;
    // And the crossfade between the two rooms, downstream of both sends: how *much* of a
    // cue goes to the tail is a property of the cue, and *which room the tail is* is a
    // property of where the player is standing. Keeping them as separate stages is what
    // lets the second change without disturbing the first.
    const interior = context.createGain();
    interior.gain.value = 1;
    const exterior = context.createGain();
    exterior.gain.value = 0;
    near.connect(interior);
    near.connect(exterior);
    far.connect(interior);
    far.connect(exterior);
    interior.connect(this.createRoom(context, ROOMS.interior)).connect(bus);
    exterior.connect(this.createRoom(context, ROOMS.exterior)).connect(bus);
    this.wetNear = near;
    this.wetFar = far;
    this.interiorSend = interior;
    this.exteriorSend = exterior;
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
    // Built before the oscillators so the shared nodes of the graph are created in one
    // run, which is also what lets the test double attribute them by construction order.
    const harmonic = context.createGain();
    harmonic.gain.value = 0;
    harmonic.connect(bus);
    const drive = context.createGain();
    drive.gain.value = 0;
    drive.connect(bus);
    // The pulse's output and the depth its gate is applied at. Both source-less and both
    // built here, before any oscillator, so the graph's shared nodes are created in one
    // run -- which is also how the test double attributes them.
    const pulse = context.createGain();
    pulse.gain.value = 0;
    pulse.connect(bus);
    const pulseDepth = context.createGain();
    pulseDepth.gain.value = 0;
    for (const [ratio, type, level] of [[1, 'sine', 1], [INTERVAL.fifth, 'triangle', 0.45]] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.value = KEY_HZ * ratio;
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
      this.floorVoices.push({ oscillator, ratio });
    }
    this.floorGain = floor;

    // The colour note. One oscillator straight into its own gain, with no balance stage
    // of its own: it is either opening or it is silent, and `sustain` owns which.
    const colour = context.createOscillator();
    colour.type = 'triangle';
    colour.frequency.value = CHAIN.harmonicHz;
    const colourFilter = context.createBiquadFilter();
    colourFilter.type = 'lowpass';
    colourFilter.frequency.value = 260;
    colourFilter.Q.value = 0.6;
    colour.connect(colourFilter).connect(harmonic);
    colour.start();
    this.harmonicGain = harmonic;

    // The movement layer. Noise rather than a tone, because speed is a rush and not a
    // note, and lowpassed hard so it stays underneath everything.
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
    this.buildPulse(context, pulse, pulseDepth);
  }

  /**
   * The pulse.
   *
   * A held oscillator through a shaping curve into the layer's own gain: the gate lives in
   * the graph rather than in a queue of scheduled events, so it cannot drift, it costs one
   * oscillator for the whole run, and -- the point -- it has no way to pull a gameplay cue
   * onto a grid. Latency is the enemy for anything the player caused; a floor that keeps
   * time is the one thing in the mix allowed to be early or late.
   *
   * The layer itself is the same noise buffer the movement layer runs on, banded rather
   * than lowpassed so it reads as a muted stick rather than as more floor. It is silent
   * until `sustain` reports a live room, and it is `pulseDepth` that opens -- the gain node
   * it drives has an intrinsic value of zero and is modulated, which is the only way to
   * have a gate and a level without one overwriting the other.
   */
  private buildPulse(context: AudioContext, pulse: GainNode, depth: GainNode): void {
    if (typeof context.createWaveShaper !== 'function' || !this.noiseBuffer) return;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = PULSE.hz;
    filter.Q.value = PULSE.q;
    filter.connect(pulse);
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.connect(filter);
    source.start();

    const clock = context.createOscillator();
    clock.type = 'sine';
    clock.frequency.value = (PULSE.bpm / 60) * PULSE.division;
    const gate = context.createWaveShaper();
    gate.curve = createGateCurve(PULSE.shape);
    clock.connect(gate).connect(depth);
    depth.connect(pulse.gain);
    clock.start();
    this.pulseGain = pulse;
    this.pulseDepth = depth;
    this.pulseFilter = filter;
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
    // How live the chain is, and every line below that reads it is a target rather than a
    // value -- so a chain opens the mix over about half a second and closes it over the
    // same, which is the difference between the player noticing a state and being tracked.
    const links = Math.max(0, state.chain.links);
    const lift = state.down ? 0 : Math.min(1, links / CHAIN.fullLinks);
    // Down is silence, not a quieter version of being alive: the floor going out from
    // under the player is the loudest thing about dying.
    const floor = state.down
      ? 0
      : (BED.floorQuiet + (BED.floorEngaged - BED.floorQuiet) * engaged) * (1 + CHAIN.floorLift * lift);
    const drive = state.down ? 0 : BED.driveQuiet + (BED.driveFull - BED.driveQuiet) * speed;
    this.floorGain.gain.setTargetAtTime?.(floor, now, BED.followSeconds);
    // The colour note carries the urgency the window reports: full while the chain has
    // time on it, fading through the last third of it.
    const holding = links > 0 ? Math.min(1, Math.max(0, state.chain.window / CHAIN.lapseFrom)) : 1;
    this.harmonicGain?.gain.setTargetAtTime?.(state.down ? 0 : CHAIN.harmonicGain * lift * holding, now, BED.followSeconds);
    this.driveGain.gain.setTargetAtTime?.(drive, now, BED.followSeconds);
    this.driveFilter.frequency.setTargetAtTime?.(
      BED.driveCutoffLow + (BED.driveCutoffHigh - BED.driveCutoffLow) * speed + CHAIN.driveOpen * lift,
      now,
      BED.followSeconds,
    );
    // The floor climbs a scale degree every few links, which is the part of this a player
    // can hum back. It is the *whole bed* that moves -- the tonic and its fifth together,
    // by the same ratio -- so the room changes key rather than growing a note.
    const degree = state.down ? 0 : Math.min(CHAIN.maxDegrees, Math.floor(links / CHAIN.linksPerDegree));
    const transpose = CHAIN_SCALE[degree] / KEY_HZ;
    for (const voice of this.floorVoices) {
      voice.oscillator.frequency.setTargetAtTime?.(KEY_HZ * voice.ratio * transpose, now, BED.followSeconds);
    }
    // Which room the tail comes back from. Followed at the bed's own rate rather than
    // switched, because the route climbs into the open over several seconds and a hard
    // switch would be the one moment in the mix that sounds like a level boundary.
    const space = Math.min(1, Math.max(0, state.space));
    this.interiorSend?.gain.setTargetAtTime?.(1 - space, now, BED.followSeconds);
    this.exteriorSend?.gain.setTargetAtTime?.(space, now, BED.followSeconds);
    // The pulse, and it is the only thing in the mix that is about the *room* rather than
    // about the player: it opens with the hostiles that can still act and it stops when
    // the last of them is down. A pulse that kept going through a cleared corridor would
    // be the thing the player turns the volume down for.
    const room = state.down ? 0 : Math.min(1, Math.max(0, state.threat / PULSE.threatFull));
    this.pulseDepth?.gain.setTargetAtTime?.(PULSE.gainFull * room, now, BED.followSeconds);
    this.pulseFilter?.frequency.setTargetAtTime?.(PULSE.hz + PULSE.chainOpen * lift, now, BED.followSeconds);
    // And the room opens up. A chain is the one time the player is moving through the
    // space fast enough for its size to be the point, so the sends carry more of it.
    this.wetNear?.gain.setTargetAtTime?.(this.sendLevels.near * (1 + CHAIN.sendLift * lift), now, BED.followSeconds);
    this.wetFar?.gain.setTargetAtTime?.(this.sendLevels.far * (1 + CHAIN.sendLift * lift), now, BED.followSeconds);
  }

  /**
   * Glue, not colour. Layered stings peak far higher than the sum of their authored
   * gains suggests, and a mix led by its low end peaks higher still -- without this the
   * loud moments clip the output rather than getting heavier.
   */
  private createLimiter(context: AudioContext): DynamicsCompressorNode {
    const limiter = context.createDynamicsCompressor();
    // Moved with the mix, so raising the level did not quietly turn the limiter from glue
    // into the loudest thing in the signal path.
    limiter.threshold.value = -14 + MIX_TRIM_DB;
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
  /** One room, as a convolver carrying its own generated impulse. */
  private createRoom(context: AudioContext, room: typeof ROOMS[keyof typeof ROOMS]): ConvolverNode {
    const reverb = context.createConvolver();
    reverb.buffer = this.createImpulseResponse(context, room);
    return reverb;
  }

  private createImpulseResponse(context: AudioContext, room: typeof ROOMS[keyof typeof ROOMS]): AudioBuffer {
    const length = Math.ceil(context.sampleRate * room.seconds);
    const buffer = context.createBuffer(2, length, context.sampleRate);
    let state = 0x2545f491;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      let damped = 0;
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        const noise = ((state >>> 0) / 0x8000_0000) - 1;
        damped += (noise - damped) * room.damping;
        data[index] = damped * (1 - index / length) ** room.decay;
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
  /**
   * When a voice built right now should start: the context's clock, plus which step of
   * the batch this event happened on, plus how long its sound took to arrive.
   */
  private startTime(extra = 0): number {
    return (this.context?.currentTime ?? 0) + this.scheduleAt + extra;
  }

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
  private tick(cutoff: number, duration: number, gainValue: number, pan: number, send: Send, q = 1.4): void {
    this.noise('bandpass', cutoff, q, duration, gainValue, pan, send);
  }

  /** The edge this swing takes, and the hand-off to the next one. */
  private nextEdge(): BladeEdge {
    const edge = this.bladeVoice.edges[this.swingRobin % this.bladeVoice.edges.length];
    this.swingRobin += 1;
    return edge;
  }

  /**
   * A struck plate, and the only thing in this mix that keeps sounding after it is hit.
   *
   * A narrow band with a long decay, which is what metal is. It sits just under the
   * kilohertz the register rule guards, deliberately: the whole point of the last pass
   * was that content up there is an edge and nothing else, and a ring that lasted eight
   * milliseconds would be a tick with extra steps while one at 1.5 kHz would be the beep
   * that pass removed.
   */
  private ring(pan: number, send: Send): void {
    this.noise('bandpass', PLATE_RING.hz, PLATE_RING.q, PLATE_RING.seconds, PLATE_RING.gain, pan, send);
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
    if (!context) return;
    const startAt = this.startTime();
    if (gainValue <= 0.0005 || !this.admit(startAt)) return;
    const output = this.output(pan, send);
    if (!output || !this.noiseBuffer) {
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
    gain.gain.setValueAtTime(gainValue, startAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    source.connect(filter).connect(gain).connect(output.destination);
    if (output.wet) gain.connect(output.wet);
    this.liveVoices += 1;
    source.onended = () => {
      this.liveVoices -= 1;
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
      output.release();
    };
    source.start(startAt);
    source.stop(startAt + duration);
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
    if (!context) return;
    const now = this.startTime();
    if (gainValue <= 0.0005 || !this.admit(now)) return;
    const output = this.output(pan, send);
    if (!output) return;
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
    this.liveVoices += 1;
    oscillator.onended = () => {
      this.liveVoices -= 1;
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
    if (!context) return;
    const startAt = this.startTime(Math.max(0, delaySeconds));
    if (gainValue <= 0.0005 || !this.admit(startAt)) return;
    const output = this.output(pan, send);
    if (!output) return;
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
    this.liveVoices += 1;
    oscillator.onended = () => {
      this.liveVoices -= 1;
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
 * What each hostile is made of, or the reference material for a caller with no roster.
 */
function materialOf(entityId: number | undefined, listener?: AudioListenerState): Material {
  const kind = entityId === undefined ? undefined : listener?.roster?.get(entityId)?.kind;
  return kind ? MATERIAL[kind] : MATERIAL.ranged;
}

/**
 * What happened to each hostile across one batch of events.
 *
 * The mix's cues used to queue because the events do: a killing slash arrives as a
 * `melee`, one `hit` per target and a `kill`, all on the same tick, and playing each of
 * them in turn is three impacts for one attack. Reading the batch first is what lets the
 * cues *combine* instead -- the kill carries the cut's edge, the cut carries the
 * material, and the confirm stands down.
 *
 * A heavy names only the nearest of the hostiles it swept (`FlowSimulation.swing`), so a
 * heavy anywhere in the batch attributes every hit in it to the blade. Firing a round on
 * the same tick as a heavy swing is possible and would be misattributed; it is also one
 * frame, and the two cues are a tick apart in brightness.
 */
function batchOutcomes(events: readonly GameEvent[]): Map<number, TargetOutcome> {
  const found = new Map<number, TargetOutcome>();
  const sweeping = events.some((event) => event.kind === 'melee' && event.heavy === true);
  for (const event of events) {
    const target = event.targetEntityId;
    if (target === undefined) continue;
    if (event.kind !== 'melee' && event.kind !== 'kill' && event.kind !== 'hit') continue;
    const outcome = found.get(target) ?? { killed: false, blade: null, deflected: false };
    if (event.kind === 'kill') outcome.killed = true;
    if (event.kind === 'melee') outcome.blade = event.heavy === true ? 'heavy' : 'light';
    if (event.kind === 'hit') {
      if (event.deflected === true) outcome.deflected = true;
      if (sweeping) outcome.blade ??= 'heavy';
    }
    found.set(target, outcome);
  }
  return found;
}

/**
 * How far a tonal layer may be detuned by the per-event variation.
 *
 * Two per cent, where the noise layers get five and a half. The point of the variation is
 * that a held trigger is not one identical waveform; the point of the key is that two
 * cues landing together agree with each other. At 5.5 per cent a sub could land 93 cents
 * off, which is most of a semitone -- wider than the smallest interval in `INTERVAL`, so
 * a "varied" root was sometimes a flat second. Thirty-five cents is a detuned root, which
 * is what was wanted. Noise has no pitch to be wrong about and keeps the wider spread.
 */
const TONAL_SPREAD = 0.02;

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
/**
 * The pulse's gate: a sine on its way in, about a fifth of a cycle sounding on its way
 * out. Raising the half-rectified cycle to a power is the cheapest percussive envelope
 * there is, and unlike a scheduled ramp it exists in the graph rather than in a queue.
 */
function createGateCurve(shape: number): Float32Array<ArrayBuffer> {
  const samples = 512;
  const curve = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const x = (index / (samples - 1)) * 2 - 1;
    curve[index] = ((x + 1) / 2) ** shape;
  }
  return curve;
}

function createDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    const x = (index / (samples - 1)) * 2 - 1;
    curve[index] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}
