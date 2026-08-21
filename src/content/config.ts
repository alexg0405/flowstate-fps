import type { AimAssistProfile, BotProfile, MovementProfile, SaveDataV1, WeaponDefinition } from '../contracts';

export const movementProfile: MovementProfile = {
  walkSpeed: 7,
  sprintSpeed: 12,
  groundAcceleration: 55,
  airAcceleration: 20,
  groundFriction: 12,
  gravity: 28,
  jumpSpeed: 10.5,
  coyoteSeconds: 0.12,
  jumpBufferSeconds: 0.14,
  slideSeconds: 0.72,
  slideBoost: 1.25,
  /**
   * Downhill acceleration while sliding, in metres per second squared at a full
   * vertical drop. Scaled by the ground normal, so a slide gains on a ramp and only
   * coasts on the flat -- which is what makes the slide a movement tool rather than a
   * one-shot boost.
   */
  slideSlopeAcceleration: 26,
  /** Speed a crouched walk is capped to. */
  crouchSpeed: 3.4,
  dashSpeed: 21,
  dashSeconds: 0.16,
  dashDoubleTapSeconds: 0.26,
  wallRunGravity: 4,
  wallJumpHorizontal: 9,
  wallJumpVertical: 10,
  grappleRange: 35,
  grappleMinimumRange: 3.5,
  grapplePullSpeed: 18,
  grapplePullImpulse: 7,
  grapplePullCooldown: 0.18,
  grappleMaxSpeed: 34,
  grappleArrivalRadius: 1.2,
  grappleCooldown: 0.35,
  grappleReleaseBoost: 2.5,
};

/**
 * Aim assist only engages while ADS is held; hip fire stays fully manual.
 *
 * The previous profile acquired inside a 45.8 degree half-angle -- roughly the whole
 * screen -- and converged on the target exponentially, closing 37 per cent of the
 * remaining angle every tick. That is an aimbot: it removed aiming as a skill in both
 * directions, since there was no floor to clear and no ceiling to reach for. What
 * replaces it is the console-standard pair: a narrow cone, damping on the player's own
 * input inside it, and a hard cap on how fast the assist may move the view itself.
 */
export const aimAssist: AimAssistProfile = {
  range: 60,
  // About 8 degrees to acquire, 13.75 to hold.
  acquireCosine: Math.cos(0.14),
  holdCosine: Math.cos(0.24),
  slowdownScale: 0.55,
  maxTurnRate: 0.35,
  aimHeight: 0.35,
};

/** Recoil is reduced while aiming, which is most of the reason to aim. */
export const recoilAdsFactor = 0.72;
/**
 * Recovery is suspended for this long after each shot. Without the hold, any recovery
 * rate fast enough to settle between bursts also cancels the kick mid-burst, and the
 * climb the player is supposed to learn never forms.
 */
export const recoilHoldSeconds = 0.12;

export const rifle: WeaponDefinition = {
  magazineSize: 30,
  reserveAmmo: 120,
  roundsPerMinute: 720,
  reloadSeconds: 1.55,
  damage: 34,
  headshotMultiplier: 1.75,
  range: 140,
  hipSpread: 0.018,
  adsSpread: 0.003,
  pellets: 1,
  adsZoom: 20,
  recoilPitch: 0.006,
  recoilYaw: 0.0022,
  recoilRecovery: 0.6,
  bloomPerShot: 0.09,
  bloomMax: 1.6,
  bloomRecovery: 2.2,
};

/**
 * Player capsule, standing and crouched. Crouching is a real collider change rather
 * than a speed modifier: without it `Ctrl` did nothing below sliding speed, and there
 * was no height to slide under.
 */
export const playerCapsule = {
  radius: 0.35,
  standingHalfHeight: 0.55,
  crouchedHalfHeight: 0.2,
  /** Eye offset above the capsule centre, standing and crouched. */
  standingEye: 0.58,
  crouchedEye: 0.26,
  /** How fast the stance transition plays out, in metres of half-height per second. */
  stanceRate: 3.2,
} as const;

/**
 * What the player has to spend, and why it went up.
 *
 * A hundred was the right number for three hostiles a room. It is the wrong number for
 * eight: five brawlers standing on the player deal about ninety damage in the second it
 * takes two heavy swings to clear them, and a hundred-point pool turns the finale into a
 * room you can only clear by never being touched. At a hundred and forty the same
 * exchange costs two thirds of the bar -- expensive, survivable, and still a reason to
 * dodge rather than trade.
 *
 * It lives here rather than as a constant in the simulation because it is tuning, and
 * because the crowd pass moved it: a number that moves belongs with the numbers it is
 * balanced against.
 */
export const playerHealth = 140;

export const botCapsule = { halfHeight: 0.68, radius: 0.35 } as const;
export const botColliderBottom = botCapsule.halfHeight + botCapsule.radius;

/**
 * How far a hostile will travel from its own spawn to reach the player.
 *
 * Without this the arenas were not rooms. A room activates when the player comes within
 * 28 m of its checkpoint, and a brawler's preferred range is 2.4 m -- so measured, the
 * Atrium's first wave walked the full forty metres back down the bridge and fought the
 * player on the *start floor*, with the arena empty behind them. The room-lock this
 * genre is built on means the fight happens in the room; hostiles that leave it to meet
 * you in the corridor turn every arena into a corridor.
 *
 * Twenty-two metres is most of the way across the widest deck on the route and nowhere
 * near off it. Only pursuit is leashed: a marksman inside its room still shoots at
 * whatever its own firing gate can see, so a player standing at the threshold is under
 * fire without the room emptying itself at them.
 */
export const botLeashMetres = 22;

export const botProfiles: Record<BotProfile['kind'], BotProfile> = {
  // The ranged hunter telegraphs longer because it shoots from further out, where
  // the player has room to break the line; the brawler is faster to commit.
  /**
   * Per-hostile damage came down when the counts went up: 10 -> 8 here and 14 -> 11 on
   * the brawler. Five brawlers on top of the player is 92 damage a second where it would
   * have been 117, which is the difference between a crowd that is expensive and a crowd
   * that is a coin flip. The threat of a crowd should be that it surrounds you, not that
   * each of it hits as hard as a duel opponent.
   */
  ranged: {
    kind: 'ranged', health: 100, moveSpeed: 4.2, preferredRange: 18, fireInterval: 0.85, damage: 8,
    windupSeconds: 0.42, baseSpread: 0.012, spreadPerSpeed: 0.0055,
  },
  /**
   * The brawler closes to inside the blade's reach, and that is the whole point of
   * the number.
   *
   * It used to stand off at five metres, which was correct for a game whose primary
   * verb was a rifle and is fatal for one whose primary verb reaches 3.6 m: measured,
   * a brawler that stopped at five metres took **zero** of twenty-two swings and
   * killed the player, because it simply shot from outside the envelope while the
   * blade cut air. At 2.4 m the same exchange is two swings, two seconds and fourteen
   * damage taken -- an enemy that has to be answered rather than one that cannot be
   * reached. `meleeStandoffFitsBlade` in `tests/meleeCombat.test.ts` holds the two
   * numbers together so neither can be retuned alone.
   *
   * A side effect worth naming: `updateBotFire` gates on `preferredRange * 1.5`, so
   * this also takes the brawler's gun away past 3.6 m. That is the right shape for it
   * now -- its threat is proximity, and the ranged hunter is the one that shoots.
   */
  aggressive: {
    kind: 'aggressive', health: 120, moveSpeed: 6.2, preferredRange: 2.4, fireInterval: 0.6, damage: 11,
    windupSeconds: 0.28, baseSpread: 0.02, spreadPerSpeed: 0.0075,
  },
  /**
   * The bulwark is the one that is not a numbers change. It walks a plate at you,
   * turns slowly enough that you can get around it, and can only shoot what it is
   * facing -- so the answer is the movement kit, not more damage. A full carbine
   * magazine into the plate does not kill it; six rounds into its flank do.
   *
   * `turnRate` is what makes the shield a puzzle rather than a wall: at 1.5 rad/s it
   * needs about a second to bring the plate round ninety degrees, and a dash crosses
   * that in a fraction of it.
   */
  bulwark: {
    kind: 'bulwark', health: 200, moveSpeed: 3.4, preferredRange: 6, fireInterval: 1.5, damage: 18,
    windupSeconds: 0.55, baseSpread: 0.014, spreadPerSpeed: 0.004,
    turnRate: 1.5,
    shield: { arcCosine: Math.cos(1.2), damageScale: 0.18 },
    fireArcCosine: Math.cos(0.5),
  },
};

/**
 * The flow chain. Two rules keep it from being farmable, and both are load bearing:
 *
 * 1. Each movement tech links at most once per chain, so no repeated input grows the
 *    multiplier. Growing a chain means using a *different* tool, which is the point
 *    of having a kit. Kills are the only repeatable link.
 * 2. An isolated link pays nothing -- scoring starts at the second link. Otherwise a
 *    flat floor with one available tech pays out forever: jump, air dash, land to
 *    recharge, repeat. The air-charge economy bounds dashes per air time, not per
 *    minute, so it is not on its own a defence.
 */
export const comboScoring = {
  /** Time a chain survives with nothing extending it. */
  linkWindowSeconds: 2.5,
  /** Multiplier added per link. */
  linkStep: 0.1,
  /** Links past this stop raising the multiplier. */
  maxLinks: 20,
  /** Awarded per paid link, so movement scores and the parkour route is not dead space. */
  linkScore: 15,
  /** Chain length at which links begin paying out. */
  payFromLink: 2,
  /**
   * Chain length that earns the all-out flourish, and how many further links earn it
   * again. Set where it is rare on purpose: an S rank needs a peak of eight links, so
   * a strong run sees this once or twice rather than on every link. A flourish that
   * fires constantly is decoration on the play frame, which is the thing the HUD pass
   * in AUDIT.md section 12 spent a phase removing.
   */
  flourishFromLink: 6,
  flourishEveryLinks: 4,
} as const;

/**
 * Whether a chain of this length has earned the all-out flourish.
 *
 * Kept here as a pure predicate rather than inline in `GameRuntime`, because that
 * class needs WebGL and Rapier to construct and so cannot be reached from a unit
 * test -- and this is the rule that decides how often a full-frame effect fires at a
 * player who is mid-air. It is the one part of the feature worth testing directly.
 */
export function chainEarnsFlourish(links: number): boolean {
  const past = links - comboScoring.flourishFromLink;
  return past >= 0 && past % comboScoring.flourishEveryLinks === 0;
}

export const ghostTrack = {
  /** Run-clock seconds between samples. Interpolated, 20 Hz keeps jump arcs faithful. */
  intervalSeconds: 0.05,
  /** Runs longer than this store no path, so a stalled attempt cannot bloat the save. */
  maxSeconds: 420,
  /**
   * Window searched around the previous match when measuring the time delta. The back
   * allowance is deliberately tiny -- just enough to absorb jitter. A route that
   * doubles back passes through the same place twice, so a generous window would let
   * the comparison snap to the earlier visit and report a lead that was not earned.
   */
  matchBackSamples: 4,
  matchForwardSamples: 200,
} as const;

/**
 * Run scoring and the rank curve. `parSeconds` is the pace an S demands; it wants
 * playtesting per route, and lives here rather than in the level schema so authored
 * levels stay on schema 2.
 */
export const runScoring = {
  /**
   * Twenty-eight hostiles across seven waves in three rooms, where this was nine in
   * three static groups. Par moved with them -- 185 s was the pace an S demanded of a
   * route with a third of the fighting in it, and holding it there would have made the
   * top grade a function of how fast the waves happen to spawn rather than of play.
   */
  parSeconds: 260,
  /**
   * Clock added at the moment of death. The run timer is frozen while the player is
   * down, so the cost of dying is this fixed amount rather than however long they
   * sit on the death panel.
   */
  deathTimePenaltySeconds: 5,
  killScore: 100,
  encounterScore: 150,
  /** Completion bonus is this minus the elapsed run time, floored at zero. */
  completionBudgetSeconds: 600,
  /**
   * Rank thresholds, checked in order. The death gate stops a slow, safe run from
   * grading the same as a clean one, and the chain gate means the top grade cannot be
   * reached by walking the route; the old curve handed S to anyone who finished.
   */
  ranks: [
    { rank: 'S', parMultiple: 1, maxDeaths: 0, minPeakCombo: 8 },
    { rank: 'A', parMultiple: 1.25, maxDeaths: 1, minPeakCombo: 4 },
    { rank: 'B', parMultiple: 1.6, maxDeaths: 3, minPeakCombo: 0 },
  ],
} as const;

/**
 * The dodge, which is the defensive verb.
 *
 * Combat without one is a damage race, and this game already had every piece of the
 * answer except the rule joining them: bots commit to a shot, announce it with a
 * telegraph, and only resolve the trace when the wind-up ends. That telegraph is a
 * window. Dashing through it is the play.
 *
 * Three numbers, and the second is the one that matters:
 *
 * - **`invulnerableSeconds`** is a little longer than the 0.16 s dash, so the window
 *   the player is aiming for is the dash plus a few frames of grace rather than the
 *   dash exactly. Judging a 0.16 s window off an audio cue is a coin flip; 0.22 s is
 *   a read.
 * - **`cooldownSeconds`** exists because a ground dash has no cooldown of its own --
 *   it can be pressed again the instant the last one ends -- so frames tied to the
 *   dash alone would be permanent invulnerability on a flat floor. Gating the frames
 *   rather than the dash keeps the movement kit exactly as it was: the dash still
 *   dashes whenever the air-charge economy allows, and only the defence is rationed.
 *   At 0.55 s the ceiling is 29 per cent uptime against a spammed dash.
 * - **A perfect dodge pays a chain link**, once per chain like every other tech, so
 *   defending extends a combo instead of interrupting it -- and cannot be farmed.
 */
export const dodge = {
  /** How long a dash's invulnerability frames last, from the moment the dash starts. */
  invulnerableSeconds: 0.22,
  /** Running time after the frames end before another dash may arm them. */
  cooldownSeconds: 0.55,
} as const;

/**
 * Life from damage, and it is the only healing in the game.
 *
 * The health pool was retuned for crowds -- 100 to 140 when the counts went from nine
 * hostiles to twenty-eight -- and the answer to being hurt has to be to fight *better*,
 * not to disengage. So there is no regeneration at all: nothing ticks back while the
 * player hides behind a pillar, and a room does not become survivable by waiting. A
 * regen that rewards retreating fights everything the pivot built.
 *
 * What is left is a kill, scaled by the chain. The chain is already the game's measure of
 * playing well, so tying the health economy to it makes the style meter matter in a second
 * dimension: a player holding a chain together is *also* the player who can afford to be
 * in the middle of a crowd. A player who drops it is on the pool they have.
 *
 * The two numbers, and what they were measured against. Five brawlers on top of the player
 * is about 92 damage a second, and a heavy one-shots a brawler and sweeps three of them:
 *
 * - **`perKill`** at 6 is a fifteenth of the pool, which is deliberately not much on its
 *   own. A kill has to be worth taking a hit for, not worth trading four.
 * - **`maxPerKill`** at 18 is what the ceiling of the chain buys -- the multiplier tops
 *   out at 3.0 on the reference blade, so the cap and the ceiling land on the same number
 *   rather than the cap quietly overriding the curve. Riposte reaches 4.0 and is capped,
 *   which is the point of a cap: the defensive blade may not also be the sustain blade.
 *
 * No per-style field. Cleave already pays two links a kill, so its chain -- and therefore
 * its healing -- grows twice as fast per body: measured over five kills, Tempo heals 9 a
 * kill where Cleave heals 12. The variation the styles argue for is already there, and a
 * field would be saying the same thing twice.
 */
export const lifesteal = {
  /** Health a kill returns at a chain multiplier of one. */
  perKill: 6,
  /** Ceiling per kill, whatever the chain says. */
  maxPerKill: 18,
} as const;

/**
 * What one kill is worth in health at this multiplier.
 *
 * A pure function next to the numbers rather than an expression at the call site, because
 * it is the shape of the whole mechanic -- linear in the chain, hard-capped -- and the
 * tests that measure the crowd read it rather than restating it.
 */
export function lifestealForKill(comboMultiplier: number): number {
  return Math.min(lifesteal.maxPerKill, lifesteal.perKill * Math.max(0, comboMultiplier));
}

/**
 * Hitstop: how long the presentation clock stops on a landed blow.
 *
 * This is the genre's signature feedback and it is **presentation only**. The
 * simulation keeps stepping at a deterministic 60 Hz throughout -- gating the fixed
 * step on a rendered effect would make gameplay a function of presentation, which is
 * the one layering rule this codebase does not bend, and would stop the run clock
 * every time the player connected.
 *
 * Two decisions in here are worth reading:
 *
 * - **Only the blade and kills freeze the frame.** A rifle round chipping a hunter
 *   does not. That is a design statement -- the blade has weight, the sidearm is a
 *   chain extender -- and it also disposes of an arithmetic problem: at 1020 rounds a
 *   minute an SMG lands a round every 3.5 frames, so a three-frame freeze per round is
 *   not hitstop, it is permanent slow motion.
 * - **A refractory gap** keeps a crowd from doing the same thing. A freeze cannot be
 *   armed again until this much *running* time has passed, so the worst case stays a
 *   stutter rather than a stall. Consecutive slashes are 0.24 s apart and clear it
 *   comfortably.
 */
export const hitstop = {
  /** Floor, at trivial damage. Three frames at 60 Hz. */
  minSeconds: 3 / 60,
  /** Ceiling, at `fullDamage` or on any kill. Six frames. */
  maxSeconds: 6 / 60,
  /**
   * Damage at which the freeze reaches its ceiling. Set just above a full slash, so a
   * clean cut nearly maxes it and a slash a shield arc ate barely registers -- which
   * is the same cue the grey hitmarker gives, said again in the frame.
   */
  fullDamage: 70,
  /** Running seconds that must pass after a freeze before another may be armed. */
  refractorySeconds: 0.1,
} as const;

/**
 * Timings for the interface's reveal sequences, in seconds. These are presentation
 * only -- nothing in `src/simulation/` reads them -- but they live here rather than
 * inline in the stylesheet because the same numbers have to be known in two places:
 * CSS drives the motion, and the components have to know when the sequence is over
 * so it can be skipped and so the numbers land on their real values.
 */
export const presentation = {
  /** Gap between one revealed line of the results screen and the next. */
  resultsStaggerSeconds: 0.055,
  /** How long a single line takes to shear into place, overshoot included. */
  resultsLineSeconds: 0.38,
  /**
   * Revealed elements in the results sequence. Only used to size the total, so an
   * extra row is a cheap change; the sequence self-terminates either way.
   */
  resultsSteps: 16,
  /** How long the headline numbers take to count onto their final value. */
  resultsCountSeconds: 0.8,
  /**
   * The between-screen wipe. Kept short because every e2e step that changes screen
   * pays it, and because a transition the player waits on stops being a flourish.
   */
  wipeSeconds: 0.52,
} as const;

/**
 * What the mix is set to before anyone touches it.
 *
 * Below unity on purpose. The mix leads with a driven low end and now holds a floor
 * under every room, so the honest default is a little under the loudest the bus can
 * be -- a player who wants more has a slider, and a player who was surprised by a
 * game opening at full output has already turned the tab off.
 */
export const audioMix = { defaultVolume: 0.8 } as const;

export const defaultSave: SaveDataV1 = {
  schemaVersion: 1,
  settings: { sensitivity: 0.002, fov: 92, cameraRoll: 0.65, headBob: 0.35, shake: 0.5, renderScale: 1, debug: false, reducedMotion: false },
  bestTimeSeconds: null,
  bestScore: 0,
  rank: null,
};
