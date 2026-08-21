import type { CSSProperties } from 'react';
import type { RunModifier, SimulationSnapshot } from '../contracts';
import { bladeStyle } from '../content/blades';
import { movementProfile, runScoring } from '../content/config';
import type { ChainOvation, DamageFeedback, DodgeMark, GhostStanding, HealMark, HitFeedback } from '../runtime/GameRuntime';
import { formatTime } from './format';

/**
 * Read from the profile the simulation uses, so retuning the hook cannot silently
 * desync the meter from the cooldown it is drawing.
 */
const GRAPPLE_COOLDOWN_SECONDS = movementProfile.grappleCooldown;
const DEATH_TIME_PENALTY_SECONDS = runScoring.deathTimePenaltySeconds;

/**
 * Four zones, and deliberately nothing else.
 *
 * - Inside roughly fifteen degrees of the crosshair: hit confirm, threat bearing,
 *   ghost delta, hook state and the chain multiplier. These are the readouts a
 *   player acts on mid-air, so they sit where the eye already is.
 * - Two corners: one health number, one ammo number.
 * - The top bar: objective, hostiles left, run clock, the day's contract.
 * - Everything else is on the pause screen (`RunStatusPanel` in `GameOverlay`).
 *
 * The one thing added since: a comic burst on a kill and an all-out flourish when the
 * chain crosses a threshold. Neither is a module. The kill burst is a restyle of the
 * hitmarker and damage number that were already there, so nothing new enters the
 * fifteen-degree budget around the crosshair; the chain flourish is a transient
 * frame-edge layer whose paint is masked out of the middle 170 px entirely, and it
 * unmounts on its own clock in `GameRuntime`.
 *
 * What was cut was mostly the same number said twice: health as a value *and* a
 * twelve-segment meter, ammo as a value *and* ten pips *and* a weapon strip,
 * speed as a value *and* a twelve-segment spectrum, and a five-chip chain rail
 * that reported availability the combo multiplier already implies.
 */
export function Hud({ snapshot, hits = [], damage = [], ghost = null, ovation = null, dodge = null, heal = null, modifier = null }: {
  snapshot: SimulationSnapshot;
  hits?: readonly HitFeedback[];
  damage?: readonly DamageFeedback[];
  ghost?: GhostStanding | null;
  /** Set only for the few hundred milliseconds after a chain crosses a threshold. */
  ovation?: ChainOvation | null;
  /** Set only for the few hundred milliseconds after a telegraphed shot was dodged. */
  dodge?: DodgeMark | null;
  /** Set only for the few hundred milliseconds after a kill returned health. */
  heal?: HealMark | null;
  modifier?: RunModifier | null;
}) {
  const grapple = snapshot.player.grapple;
  const health = Math.max(0, Math.ceil(snapshot.player.health));
  // Read from the simulation rather than assumed: the bands are fractions of whatever
  // full health is, not of a constant the HUD keeps its own copy of.
  const maxHealth = Math.max(1, snapshot.entities.find((entity) => entity.kind === 'player')?.maxHealth ?? health);
  const hostiles = snapshot.entities.filter((entity) => entity.kind === 'bot' && entity.health > 0).length;
  const healthState = health <= maxHealth * 0.25 ? 'critical' : health <= maxHealth * 0.6 ? 'warning' : 'nominal';
  const grappleState = grapple.active ? 'TETHERED' : grapple.available ? 'ARMED' : 'RELINK';
  const grappleProgress = grapple.active || grapple.available ? 1 : Math.max(0, 1 - grapple.cooldown / GRAPPLE_COOLDOWN_SECONDS);
  const locked = snapshot.player.lockedTargetId !== null;
  // A state on the reticle rather than a module beside it. It lasts 0.22 s and says
  // the one thing worth knowing in that moment: nothing can touch you right now.
  const invulnerable = snapshot.player.dodge.invulnerable;
  const magazineSize = Math.max(1, snapshot.player.magazineSize);
  const ammoFraction = snapshot.player.ammo / magazineSize;
  const reloading = snapshot.player.action === 'reloading';
  // What is actually in the player's hands, read from the simulation rather than guessed.
  // The corner used to name the active gun and its magazine unconditionally, so it read
  // `CARBINE 30/120` while a blade was on screen -- and it could not have been fixed here
  // alone, because the decision was a private timer inside `ViewmodelPresenter`.
  const gunInHand = snapshot.player.weapons.inHand === 'gun';
  const blade = bladeStyle(snapshot.player.weapons.blade);
  const activeWeapon = snapshot.player.weapons.slots[snapshot.player.weapons.activeSlot];
  // A magazine that is not in the player's hands is not a warning. The low and empty
  // states -- and the corner flag and root class they drive -- belong to the gun.
  const ammoState = !gunInHand ? 'nominal' : snapshot.player.ammo === 0 ? 'empty' : ammoFraction <= 0.25 ? 'low' : 'nominal';
  // Each hit gets a stable key, so the CSS animation replays per hit without timers.
  const latestHit = hits.at(-1);
  const down = snapshot.player.awaitingRespawn;
  const latestSplit = snapshot.splits.at(-1);
  const combo = snapshot.player.combo;
  const ghostDelta = ghost?.deltaSeconds ?? null;
  // Ahead of the record is the reward; the sign is what the player reads at a glance.
  const ghostState = ghostDelta === null ? 'none' : ghostDelta <= 0 ? 'ahead' : 'behind';
  // Urgency is the point of the window: the readout has to show the chain lapsing.
  const comboState = combo.links === 0 ? 'idle' : combo.window <= 0.34 ? 'lapsing' : 'live';

  return (
    <div className={`hud health-${healthState} ammo-${ammoState} ${grapple.active ? 'is-grappling' : ''} ${down ? 'is-down' : ''}`} aria-live="polite" aria-atomic="false">
      <div className={`hud-vignette vignette-${healthState}`} aria-hidden="true" />
      {down && (
        // Kept inside the HUD rather than the overlay so Pointer Lock is never
        // released to respawn: the player presses a key and is straight back in.
        <div className="down-panel" role="alert">
          <span className="micro-label">ELIMINATED</span>
          <strong className="down-title">RESPAWN AT CHECKPOINT</strong>
          <p className="down-prompt"><kbd>SPACE</kbd> or <kbd>LMB</kbd> to redeploy</p>
          <p className="down-cost">Death {snapshot.player.deaths} · +{DEATH_TIME_PENALTY_SECONDS}s added to the clock</p>
        </div>
      )}
      <div className="hud-objective">
        <div className="objective-line">
          {hostiles > 0 && <span className="objective-count" aria-label={`${hostiles} hostile${hostiles === 1 ? '' : 's'} remaining`}>{hostiles.toString().padStart(2, '0')}</span>}
          <strong>{snapshot.objective}</strong>
          {/* A room with waves has to say so, or clearing one and having the next arrive
              reads as a bug rather than as the room. It goes on the top bar with the
              objective it belongs to, not near the crosshair. */}
          {snapshot.wave.total > 1 && (
            <span className="objective-wave" aria-label={`Wave ${snapshot.wave.current} of ${snapshot.wave.total}`}>
              W{snapshot.wave.current}<i>/{snapshot.wave.total}</i>
            </span>
          )}
          <span className="objective-clock" aria-label="Run time">{formatTime(snapshot.elapsedSeconds)}</span>
        </div>
        {modifier && <div className="objective-modifier"><i aria-hidden="true" />{modifier.label.toUpperCase()}</div>}
      </div>
      {latestSplit && (
        <div className="split-readout" key={latestSplit.encounterId} aria-label={`${latestSplit.label} split`}>
          <span>{latestSplit.label.toUpperCase()}</span><strong>{formatTime(latestSplit.seconds)}</strong>
        </div>
      )}
      <div className="damage-layer" aria-hidden="true">
        {hits.map((hit) => (
          <span
            key={hit.id}
            className={`damage-number ${hit.kill ? 'is-kill' : hit.headshot ? 'is-headshot' : hit.deflected ? 'is-deflected' : ''}`}
            style={{ left: `${hit.screen[0]}px`, top: `${hit.screen[1]}px` }}
          >{hit.amount}</span>
        ))}
      </div>
      {/* The all-out flourish. Masked hollow in the middle, so nothing it draws lands
          inside the fifteen degrees the reticle cluster is budgeted -- 93 px at 720p
          and a 92-degree vertical FOV, against a 170 px hole. Keyed on the event so a
          second threshold replays the animation instead of extending the first. */}
      {ovation && (
        <div className="chain-ovation" key={ovation.id} aria-hidden="true">
          <i className="ovation-burst" />
          <span className="ovation-mark"><b>{ovation.links}</b><em>CHAIN</em></span>
        </div>
      )}
      {/* The perfect dodge. A corner mark rather than anything near the crosshair, and
          on the opposite side from the chain flourish because a dodge pays a link and
          the two can land on the same frame. Under reduced motion it still says what
          happened; it just does not move. */}
      {dodge && (
        <div className="perfect-dodge" key={dodge.id} aria-hidden="true">
          <b>PERFECT</b><em>DODGE</em><i>{dodge.refused}</i>
        </div>
      )}
      <div className="threat-compass" aria-hidden="true">
        {damage.map((wedge) => (
          <span
            key={wedge.id}
            className={`threat-wedge ${wedge.amount >= 14 ? 'is-heavy' : ''}`}
            // Bearing is radians clockwise from straight ahead, so the wedge points
            // back at whoever fired rather than at where the shot happened to land.
            style={{ transform: `rotate(${(wedge.bearing * 180) / Math.PI}deg)` }}
          />
        ))}
      </div>
      {/* A deflected confirm reads differently on purpose: the shot landed, and it
          did almost nothing, which is the cue to go round rather than keep firing. */}
      {latestHit && <span key={latestHit.id} className={`hitmarker ${latestHit.kill ? 'is-kill' : latestHit.headshot ? 'is-headshot' : latestHit.deflected ? 'is-deflected' : ''}`} aria-hidden="true" />}
      <div
        className={`crosshair ${grapple.active ? 'locked' : grapple.available ? 'hook-ready' : 'cooldown'} ${locked ? 'target-locked' : ''} ${invulnerable ? 'dodge-live' : ''}`}
        // Sustained fire widens the spread, so the crosshair widens with it. Firing
        // blind into a bloomed cone was previously invisible.
        style={{ '--bloom': snapshot.player.spreadBloom } as CSSProperties}
        aria-hidden="true"
      ><i /><i /><b>◇</b><span className="crosshair-bracket bracket-left" /><span className="crosshair-bracket bracket-right" /></div>
      {locked && <div className="lock-indicator" aria-label="Target locked"><strong>LOCK</strong></div>}
      {/* Anchored on the reticle rather than the screen edges: everything in here
          is read while the player is airborne and looking at the crosshair. */}
      <div className="flow-cluster">
        {ghostDelta !== null && (
          <div className={`ghost-delta ghost-${ghostState}`} aria-label={`${Math.abs(ghostDelta).toFixed(2)} seconds ${ghostState} of the record`}>
            <span>VS BEST</span>
            <strong>{ghostDelta <= 0 ? '-' : '+'}{Math.abs(ghostDelta).toFixed(2)}</strong>
          </div>
        )}
        <div className="flow-row">
          <div className={`grapple-readout grapple-${grapple.active ? 'active' : grapple.available ? 'ready' : 'cooldown'}`} aria-label={`Grapple ${grappleState.toLowerCase()}`}>
            <strong>{grapple.active ? `PULL ${grapple.ropeLength.toFixed(0)}M` : grapple.available ? 'HOOK' : grapple.cooldown.toFixed(1)}</strong>
            <i style={{ transform: `scaleX(${grappleProgress})` }} />
          </div>
          <div className={`combo-readout combo-${comboState}`} aria-label={`Chain ${combo.links} link${combo.links === 1 ? '' : 's'} at ${combo.multiplier.toFixed(1)} times`}>
            <strong className="combo-multiplier">×{combo.multiplier.toFixed(1)}</strong>
            {combo.links > 0 && <span className="combo-links">{combo.links} LINK{combo.links === 1 ? '' : 'S'}</span>}
            <i className="combo-window" style={{ transform: `scaleX(${combo.window})` }} />
          </div>
        </div>
      </div>
      {/* The health corner, and the one thing added to it: what a kill just paid back.
          Inside the readout it belongs to rather than beside it, keyed on the event so a
          second kill replays the mark instead of extending the first, and it is the same
          number the mix is playing at the same moment. */}
      <div className={`hud-health ${heal ? 'is-healing' : ''}`}>
        <div className="health-value" aria-label={`Health ${health} of ${maxHealth}`}><strong>{health}</strong><span>HP</span></div>
        {heal && <b className="heal-mark" key={heal.id} aria-label={`${heal.amount} health returned`}>+{heal.amount}</b>}
        {healthState !== 'nominal' && <b className="corner-flag">{healthState.toUpperCase()}</b>}
      </div>
      {/* One corner, two things it can be about. The blade has no magazine, so it says
          the style instead of a number it does not have -- and the gun keeps the
          magazine readout and the capacity its `aria-label` announces, which is
          accessibility work that has survived two HUD passes. */}
      <div className={`hud-ammo ${gunInHand ? 'holding-gun' : 'holding-blade'}`}>
        <div className="ammo-weapon">
          <span>{gunInHand ? activeWeapon?.name ?? '' : blade.label}</span>
          {ammoState !== 'nominal' && <b className="corner-flag">{ammoState === 'empty' ? 'EMPTY' : 'LOW'}</b>}
        </div>
        {gunInHand ? (
          <div className="ammo-value" aria-label={`${snapshot.player.ammo} of ${magazineSize} rounds in magazine`}>
            <strong>{snapshot.player.ammo}</strong><span>/ {snapshot.player.reserveAmmo}</span>
          </div>
        ) : (
          <div className="ammo-value blade-value" aria-label={`${blade.label} blade in hand, no ammunition`}>
            <strong>BLADE</strong><span>◇</span>
          </div>
        )}
        {reloading && <div className="reload-track" role="progressbar" aria-label="Reloading"><i style={{ transform: `scaleX(${snapshot.player.actionProgress})` }} /></div>}
      </div>
    </div>
  );
}
