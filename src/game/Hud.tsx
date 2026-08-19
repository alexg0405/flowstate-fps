import type { CSSProperties } from 'react';
import type { RunModifier, SimulationSnapshot } from '../contracts';
import { movementProfile, runScoring } from '../content/config';
import type { DamageFeedback, GhostStanding, HitFeedback } from '../runtime/GameRuntime';
import { Meter, StatusChip } from '../ui/Primitives';
import { formatTime } from './format';

/**
 * Read from the profile the simulation uses, so retuning the hook cannot silently
 * desync the meter from the cooldown it is drawing.
 */
const GRAPPLE_COOLDOWN_SECONDS = movementProfile.grappleCooldown;
const DEATH_TIME_PENALTY_SECONDS = runScoring.deathTimePenaltySeconds;
const AMMO_PIPS = 10;

export function Hud({ snapshot, hits = [], damage = [], ghost = null, modifier = null }: {
  snapshot: SimulationSnapshot;
  hits?: readonly HitFeedback[];
  damage?: readonly DamageFeedback[];
  ghost?: GhostStanding | null;
  modifier?: RunModifier | null;
}) {
  const grapple = snapshot.player.grapple;
  const health = Math.max(0, Math.ceil(snapshot.player.health));
  const hostiles = snapshot.entities.filter((entity) => entity.kind === 'bot' && entity.health > 0).length;
  const movementLabel = snapshot.player.locomotion.replaceAll('-', ' ').toUpperCase();
  const healthState = health <= 25 ? 'critical' : health <= 60 ? 'warning' : 'nominal';
  const grappleState = grapple.active ? 'TETHERED' : grapple.available ? 'ARMED' : 'RELINK';
  const grappleProgress = grapple.active || grapple.available ? 1 : Math.max(0, 1 - grapple.cooldown / GRAPPLE_COOLDOWN_SECONDS);
  const locked = snapshot.player.lockedTargetId !== null;
  const magazineSize = Math.max(1, snapshot.player.magazineSize);
  const ammoFraction = snapshot.player.ammo / magazineSize;
  const ammoState = snapshot.player.ammo === 0 ? 'empty' : ammoFraction <= 0.25 ? 'low' : 'nominal';
  const reloading = snapshot.player.action === 'reloading';
  // Each hit gets a stable key, so the CSS animation replays per hit without timers.
  const latestHit = hits.at(-1);
  const down = snapshot.player.awaitingRespawn;
  const latestSplit = snapshot.splits.at(-1);
  const combo = snapshot.player.combo;
  const ghostDelta = ghost?.deltaSeconds ?? null;
  // Ahead of the record is the reward; the sign is what the player reads at a glance.
  const ghostState = ghostDelta === null ? 'none' : ghostDelta <= 0 ? 'ahead' : 'behind';
  // Urgency is the point of the window: the rail has to show the chain lapsing.
  const comboState = combo.links === 0 ? 'idle' : combo.window <= 0.34 ? 'lapsing' : 'live';

  return (
    <div className={`hud health-${healthState} ammo-${ammoState} ${grapple.active ? 'is-grappling' : ''} ${down ? 'is-down' : ''}`} aria-live="polite" aria-atomic="false">
      <div className={`hud-vignette vignette-${healthState}`} aria-hidden="true" />
      <div className="hud-frame" aria-hidden="true">
        <i className="frame-notch frame-notch-left" />
        <i className="frame-notch frame-notch-right" />
      </div>
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
        <span className="hud-kicker"><i />OBJECTIVE</span>
        <div className="objective-title"><strong>{snapshot.objective}</strong></div>
        {modifier && <div className="objective-modifier"><i aria-hidden="true" />{modifier.label.toUpperCase()}</div>}
      </div>
      {latestHit && <span key={latestHit.id} className={`hitmarker ${latestHit.kill ? 'is-kill' : latestHit.headshot ? 'is-headshot' : ''}`} aria-hidden="true" />}
      <div
        className={`crosshair ${grapple.active ? 'locked' : grapple.available ? 'hook-ready' : 'cooldown'} ${locked ? 'target-locked' : ''}`}
        // Sustained fire widens the spread, so the crosshair widens with it. Firing
        // blind into a bloomed cone was previously invisible.
        style={{ '--bloom': snapshot.player.spreadBloom } as CSSProperties}
        aria-hidden="true"
      ><i /><i /><b>◇</b><span className="crosshair-bracket bracket-left" /><span className="crosshair-bracket bracket-right" /></div>
      {locked && <div className="lock-indicator" aria-label="Target locked"><strong>LOCK</strong></div>}
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
      <div className="damage-layer" aria-hidden="true">
        {hits.map((hit) => (
          <span
            key={hit.id}
            className={`damage-number ${hit.kill ? 'is-kill' : hit.headshot ? 'is-headshot' : ''}`}
            style={{ left: `${hit.screen[0]}px`, top: `${hit.screen[1]}px` }}
          >{hit.amount}</span>
        ))}
      </div>
      <div className={`grapple-readout grapple-${grapple.active ? 'active' : grapple.available ? 'ready' : 'cooldown'}`} aria-label={`Grapple ${grappleState.toLowerCase()}`}>
        <div className="grapple-copy"><span className="micro-label">{grappleState}</span><strong>{grapple.active ? `Q · PULL ${grapple.ropeLength.toFixed(0)}M` : grapple.available ? 'F · HOOK' : grapple.cooldown.toFixed(1)}</strong></div>
        <i style={{ transform: `scaleX(${grappleProgress})` }} />
        <span className="grapple-scale" aria-hidden="true"><i /><i /><i /><i /><i /></span>
      </div>
      <div className="hud-telemetry" aria-label="Movement telemetry">
        <div className="hud-run">
          <div><span>ELAPSED</span><strong>{formatTime(snapshot.elapsedSeconds)}</strong></div>
          <div><span>SCORE</span><strong>{snapshot.player.score.toLocaleString()}</strong></div>
          <div className={snapshot.player.deaths > 0 ? 'run-deaths has-deaths' : 'run-deaths'}><span>DEATHS</span><strong>{snapshot.player.deaths}</strong></div>
          {ghostDelta !== null && (
            <div className={`ghost-delta ghost-${ghostState}`} aria-label={`${Math.abs(ghostDelta).toFixed(2)} seconds ${ghostState} of the record`}>
              <span>VS BEST</span>
              <strong>{ghostDelta <= 0 ? '-' : '+'}{Math.abs(ghostDelta).toFixed(2)}</strong>
            </div>
          )}
        </div>
        {latestSplit && (
          <div className="split-readout" key={latestSplit.encounterId} aria-label={`${latestSplit.label} split`}>
            <span>{latestSplit.label.toUpperCase()}</span><strong>{formatTime(latestSplit.seconds)}</strong>
          </div>
        )}
        <div className="motion-readout">
          <div className="motion-heading"><strong>{movementLabel}</strong></div>
          <div className="speed-readout"><strong>{snapshot.player.speed.toFixed(1)}</strong><span>M/S</span></div>
          <div className="speed-spectrum" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i className={index < Math.ceil(Math.min(snapshot.player.speed, 24) / 2) ? 'is-lit' : ''} key={index} />)}</div>
        </div>
      </div>
      <div className="hud-health">
        <div className="module-heading"><span>HEALTH</span><b>{healthState.toUpperCase()}</b></div>
        <div className="health-value"><strong>{health}</strong><span>HP</span></div>
        <Meter label="HP" value={snapshot.player.health} max={100} segments={12} tone={healthState === 'critical' ? 'red' : 'cyan'} />
      </div>
      <div className="hud-ammo">
        <div className="module-heading"><span>AMMO</span><b>{ammoState === 'empty' ? 'EMPTY' : ammoState === 'low' ? 'LOW' : snapshot.player.action.toUpperCase()}</b></div>
        <div className="ammo-value"><strong>{snapshot.player.ammo}</strong><span>/ {snapshot.player.reserveAmmo}</span></div>
        <div className="weapon-strip" role="group" aria-label="Carried weapons">
          {snapshot.player.weapons.slots.map((slot, index) => (
            <span key={slot.name + index} className={index === snapshot.player.weapons.activeSlot ? 'is-active' : ''}>
              <b>{index + 1}</b>{slot.name}<i>{slot.ammo}</i>
            </span>
          ))}
        </div>
        <div className="ammo-track" aria-label={`${snapshot.player.ammo} of ${magazineSize} rounds in magazine`}>{Array.from({ length: AMMO_PIPS }, (_, index) => <i className={index < Math.ceil(ammoFraction * AMMO_PIPS) ? 'is-loaded' : ''} key={index} />)}</div>
        {reloading && <div className="reload-track" role="progressbar" aria-label="Reloading"><i style={{ transform: `scaleX(${snapshot.player.actionProgress})` }} /></div>}
      </div>
      <div className="threat-readout" aria-label={`${hostiles} hostiles remaining`}>
        <div className="threat-count"><span>HOSTILES</span><strong>{hostiles.toString().padStart(2, '0')}</strong></div>
      </div>
      <div className={`chain-rail combo-${comboState}`} role="group" aria-label="Movement chain availability">
        <div className="chain-caption"><strong>CHAIN</strong></div>
        <div className="combo-readout" aria-label={`Chain ${combo.links} links at ${combo.multiplier.toFixed(1)} times`}>
          <strong className="combo-multiplier">×{combo.multiplier.toFixed(1)}</strong>
          <span className="combo-links">{combo.links} LINK{combo.links === 1 ? '' : 'S'}</span>
          <i className="combo-window" style={{ transform: `scaleX(${combo.window})` }} />
        </div>
        <div className="chain-track">
          <div className={`chain-step ${snapshot.player.dashAvailable ? 'is-ready' : ''}`}><small>01</small><StatusChip active={snapshot.player.dashAvailable}>DASH</StatusChip></div>
          <i aria-hidden="true">››</i>
          <div className={`chain-step ${snapshot.player.jumpCancelAvailable ? 'is-ready' : ''}`}><small>02</small><StatusChip active={snapshot.player.jumpCancelAvailable}>JUMP</StatusChip></div>
          <i aria-hidden="true">››</i>
          <div className={`chain-step ${snapshot.player.airCharge ? 'is-ready' : ''}`}><small>03</small><StatusChip active={!!snapshot.player.airCharge}>AIR</StatusChip></div>
          <i aria-hidden="true">››</i>
          <div className={`chain-step ${snapshot.player.wallJumpAvailable ? 'is-ready' : ''}`}><small>04</small><StatusChip active={snapshot.player.wallJumpAvailable}>WALL</StatusChip></div>
          <i aria-hidden="true">››</i>
          <div className={`chain-step ${grapple.active || grapple.available ? 'is-ready' : ''}`}><small>05</small><StatusChip active={grapple.active || grapple.available}>HOOK</StatusChip></div>
        </div>
        <span className="chain-status">{
          combo.links > 0
            ? `CHAIN LIVE — PEAK ${combo.peakLinks}`
            : grapple.active ? 'HOOKED'
              : snapshot.player.wallJumpAvailable ? 'WALL CONTACT — JUMP TO KICK'
                : snapshot.player.airCharge ? 'AIR DASH READY' : 'TOUCH GROUND OR WALL TO RECHARGE'
        }</span>
      </div>
    </div>
  );
}
