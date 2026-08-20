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
  meleeDamage: 70,
  meleeRange: 2.25,
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
 * Bot capsule geometry. The authored hunter models stand 2.06 m tall with their
 * origin at the feet, so the capsule is sized to match the visible silhouette and
 * the renderer offsets the model down by `botColliderBottom` to sit on it.
 */
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

export const botCapsule = { halfHeight: 0.68, radius: 0.35 } as const;
export const botColliderBottom = botCapsule.halfHeight + botCapsule.radius;

export const botProfiles: Record<BotProfile['kind'], BotProfile> = {
  // The ranged hunter telegraphs longer because it shoots from further out, where
  // the player has room to break the line; the brawler is faster to commit.
  ranged: {
    kind: 'ranged', health: 100, moveSpeed: 4.2, preferredRange: 18, fireInterval: 0.85, damage: 10,
    windupSeconds: 0.42, baseSpread: 0.012, spreadPerSpeed: 0.0055,
  },
  aggressive: {
    kind: 'aggressive', health: 120, moveSpeed: 6.2, preferredRange: 5, fireInterval: 0.6, damage: 14,
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
} as const;

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
  // Nine hostiles across three arenas, one of which has to be worked around rather
  // than shot down. Par moved with the route; it is the pace an S demands.
  parSeconds: 185,
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

export const defaultSave: SaveDataV1 = {
  schemaVersion: 1,
  settings: { sensitivity: 0.002, fov: 92, cameraRoll: 0.65, headBob: 0.35, shake: 0.5, renderScale: 1, debug: false, reducedMotion: false },
  bestTimeSeconds: null,
  bestScore: 0,
  rank: null,
};
