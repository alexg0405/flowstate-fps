import type { CSSProperties } from 'react';
import type { RunModifier, SimulationSnapshot } from '../contracts';
import { movementProfile, runScoring } from '../content/config';
import type { DamageFeedback, GhostStanding, HitFeedback } from '../runtime/GameRuntime';
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
 * What was cut was mostly the same number said twice: health as a value *and* a
 * twelve-segment meter, ammo as a value *and* ten pips *and* a weapon strip,
 * speed as a value *and* a twelve-segment spectrum, and a five-chip chain rail
 * that reported availability the combo multiplier already implies.
 */
export function Hud({ snapshot, hits = [], damage = [], ghost = null, modifier = null }: {
  snapshot: SimulationSnapshot;
  hits?: readonly HitFeedback[];
  damage?: readonly DamageFeedback[];
  ghost?: GhostStanding | null;
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
  const magazineSize = Math.max(1, snapshot.player.magazineSize);
  const ammoFraction = snapshot.player.ammo / magazineSize;
  const ammoState = snapshot.player.ammo === 0 ? 'empty' : ammoFraction <= 0.25 ? 'low' : 'nominal';
  const reloading = snapshot.player.action === 'reloading';
  // The weapon strip moved to the pause screen, so the corner names the live gun.
  const activeWeapon = snapshot.player.weapons.slots[snapshot.player.weapons.activeSlot];
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
        className={`crosshair ${grapple.active ? 'locked' : grapple.available ? 'hook-ready' : 'cooldown'} ${locked ? 'target-locked' : ''}`}
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
      <div className="hud-health">
        <div className="health-value" aria-label={`Health ${health} of ${maxHealth}`}><strong>{health}</strong><span>HP</span></div>
        {healthState !== 'nominal' && <b className="corner-flag">{healthState.toUpperCase()}</b>}
      </div>
      <div className="hud-ammo">
        <div className="ammo-weapon">
          <span>{activeWeapon?.name ?? ''}</span>
          {ammoState !== 'nominal' && <b className="corner-flag">{ammoState === 'empty' ? 'EMPTY' : 'LOW'}</b>}
        </div>
        <div className="ammo-value" aria-label={`${snapshot.player.ammo} of ${magazineSize} rounds in magazine`}>
          <strong>{snapshot.player.ammo}</strong><span>/ {snapshot.player.reserveAmmo}</span>
        </div>
        {reloading && <div className="reload-track" role="progressbar" aria-label="Reloading"><i style={{ transform: `scaleX(${snapshot.player.actionProgress})` }} /></div>}
      </div>
    </div>
  );
}
