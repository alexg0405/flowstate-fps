import { useEffect, useState, type CSSProperties } from 'react';
import type { RunModifier, RuntimeLevelV1, SaveDataV4, SaveSettingsV2, SimulationSnapshot } from '../contracts';
import { playUiCue } from '../audio/interfaceAudio';
import type { RecordedRun } from '../persistence/saveStore';
import { presentation } from '../content/config';
import { Meter, UiPanel } from '../ui/Primitives';
import { WeaponBuilder } from '../ui/WeaponBuilder';
import { countTo, resultsSequenceSeconds, stepDelaySeconds, useRevealSequence } from '../ui/sequence';
import { formatTime } from './format';

export type ScreenState = 'fault' | 'complete' | 'booting' | 'active' | 'standby';

interface GameOverlayProps {
  screenState: ScreenState;
  error: string | null;
  snapshot: SimulationSnapshot | undefined;
  level: RuntimeLevelV1;
  settings: SaveSettingsV2;
  save: SaveDataV4;
  /** Set once the finished run has been graded and persisted. */
  result?: RecordedRun | null;
  /** The day's rules, or null outside a daily. */
  modifier?: RunModifier | null;
  onSaveChange: (next: SaveDataV4) => void;
  onSettingsChange: (patch: Partial<SaveSettingsV2>) => void;
  onEnter: () => void;
  onExit: () => void;
}

export function GameOverlay({ screenState, error, snapshot, level, settings, save, result, modifier = null, onSaveChange, onSettingsChange, onEnter, onExit }: GameOverlayProps) {
  const loading = screenState === 'booting';
  const [builderOpen, setBuilderOpen] = useState(false);

  if (builderOpen) {
    return (
      <div className="game-overlay overlay-builder">
        <UiPanel className="start-card builder-card">
          <WeaponBuilder save={save} onChange={onSaveChange} onClose={() => setBuilderOpen(false)} deferredNotice reducedMotion={settings.reducedMotion} />
        </UiPanel>
      </div>
    );
  }

  return (
    <div className={`game-overlay overlay-${screenState}`}>
      <div className="overlay-backdrop" aria-hidden="true">
        <span className="overlay-wordmark">FLOW/STATE</span>
      </div>
      <UiPanel className="start-card" aria-labelledby="game-overlay-title">
        <header className="start-card-header">
          <p className="eyebrow">WHITE LINE</p>
          <span className={`system-pill system-${screenState}`}><i />{error ? 'LINK FAULT' : snapshot?.completed ? 'ROUTE CLEAR' : loading ? 'SYNCHRONIZING' : 'INPUT SUSPENDED'}</span>
        </header>
        <h1 id="game-overlay-title">{error ? 'Runtime fault' : snapshot?.completed ? 'Run complete' : loading ? 'Loading simulation' : 'Click into the flow'}</h1>
        {error ? (
          <div className="overlay-state fault-state">
            <div className="fault-code" aria-hidden="true"><span>ERR</span><strong>0x77</strong></div>
            <div className="fault-copy">
              <span className="micro-label">RUNTIME DIAGNOSTIC // RECOVERABLE</span>
              <p className="error-text">{error}</p>
            </div>
            <div className="overlay-actions"><button className="primary" onClick={onExit}><span aria-hidden="true">←</span>Return to menu</button></div>
          </div>
        ) : snapshot?.completed ? (
          <CompletionState snapshot={snapshot} level={level} result={result ?? null} modifier={modifier} reducedMotion={settings.reducedMotion} onExit={onExit} />
        ) : !loading ? (
          <div className="overlay-state standby-state">
            <p className="state-deck">Input is released. Click back in to restore movement and combat.</p>
            {snapshot
              ? <RunStatusPanel snapshot={snapshot} />
              : (
                <div className="run-brief">
                  <div><span className="micro-label">ROUTE</span><strong>{level.name}</strong></div>
                  <div><span className="micro-label">ARENAS</span><strong>{Math.max(1, level.encounters.length).toString().padStart(2, '0')}</strong></div>
                </div>
              )}
            {modifier && <ModifierBrief modifier={modifier} />}
            <div className="guide-heading"><span>Controls</span></div>
            <div className="control-guide">
              <span><kbd>LMB</kbd> SLASH</span>
              <span><kbd>RMB</kbd> SIDEARM</span>
              <span><kbd>WASD</kbd> MOVE</span>
              <span><kbd>SPACE</kbd> JUMP</span>
              <span><kbd>SPACE ×2</kbd> DASH</span>
              <span><kbd>F</kbd> HOOK</span>
              <span><kbd>Q</kbd> PULL</span>
              <span><kbd>SPACE</kbd> WALL JUMP</span>
              <span><kbd>C</kbd> SLIDE</span>
              <span><kbd>V</kbd> AIM</span>
              <span><kbd>R</kbd> RELOAD</span>
            </div>
            <SettingsPanel settings={settings} onChange={onSettingsChange} />
            <div className="overlay-actions">
              <button className="primary enter-action" onClick={onEnter}><span aria-hidden="true">▶</span>Enter run</button>
              <button onClick={() => setBuilderOpen(true)}>Gun builder</button>
              <span className="input-note"><i />Captures your mouse</span>
            </div>
          </div>
        ) : (
          <div className="overlay-state loading-state" role="status" aria-label="Loading game systems">
            <p className="state-deck">Loading physics, navigation, and renderer.</p>
            <div className="loading-bar"><i /><span /></div>
          </div>
        )}
      </UiPanel>
    </div>
  );
}

/**
 * The pause screen is where the reduced HUD sends everything it stopped drawing.
 * Elapsed, score, deaths, hostiles left, peak chain, vitals, the carried weapons
 * and the splits so far are all still one keystroke away — they just are not
 * competing with the crosshair while the player is moving.
 */
function RunStatusPanel({ snapshot }: { snapshot: SimulationSnapshot }) {
  const hostiles = snapshot.entities.filter((entity) => entity.kind === 'bot' && entity.health > 0).length;
  const health = Math.max(0, Math.ceil(snapshot.player.health));
  // The simulation publishes what full health is; nothing here keeps its own copy.
  const maxHealth = Math.max(1, snapshot.entities.find((entity) => entity.kind === 'player')?.maxHealth ?? health);
  return (
    <div className="run-status">
      {/* One row: the card header already names the route, and the pause screen has
          to stay short enough that resuming is not a scroll away. */}
      <div className="run-brief">
        <div><span className="micro-label">ELAPSED</span><strong>{formatTime(snapshot.elapsedSeconds)}</strong></div>
        <div><span className="micro-label">SCORE</span><strong>{snapshot.player.score.toLocaleString()}</strong></div>
        <div><span className="micro-label">DEATHS</span><strong>{snapshot.player.deaths}</strong></div>
        <div><span className="micro-label">HOSTILES</span><strong>{hostiles.toString().padStart(2, '0')}</strong></div>
        <div><span className="micro-label">PEAK CHAIN</span><strong>{snapshot.player.combo.peakLinks}</strong></div>
      </div>
      <div className="run-status-detail">
        <Meter label="HP" value={health} max={maxHealth} segments={12} tone={health <= maxHealth * 0.25 ? 'red' : 'cyan'} />
        <div className="weapon-strip" role="group" aria-label="Carried weapons">
          {snapshot.player.weapons.slots.map((slot, index) => (
            <span key={slot.name + index} className={index === snapshot.player.weapons.activeSlot ? 'is-active' : ''}>
              <b>{index + 1}</b>{slot.name}<i>{slot.ammo}</i>
            </span>
          ))}
        </div>
      </div>
      {snapshot.splits.length > 0 && <SplitTable splits={snapshot.splits} />}
    </div>
  );
}

/**
 * Shared by the pause screen and the completion screen. A reference run is
 * optional because mid-run there may not be one, and inventing a delta against
 * a split that was never set would be a lie.
 */
function SplitTable({ splits, reference = [], sequenced = false, firstStep = 0 }: {
  splits: SimulationSnapshot['splits'];
  reference?: readonly { encounterId: string; seconds: number }[];
  /** Set on the results screen, where the rows arrive one at a time. */
  sequenced?: boolean;
  firstStep?: number;
}) {
  return (
    <div className="split-table" aria-label="Checkpoint splits">
      <div className={`guide-heading ${sequenced ? 'reveal-line' : ''}`} style={sequenced ? step(firstStep) : undefined}><span>Splits</span></div>
      {splits.map((split, index) => {
        const matched = reference.find((candidate) => candidate.encounterId === split.encounterId);
        const delta = matched ? split.seconds - matched.seconds : null;
        return (
          <div className={`split-row ${sequenced ? 'reveal-line' : ''}`} key={split.encounterId} style={sequenced ? step(firstStep + index + 1) : undefined}>
            <span className="split-label">{split.label}</span>
            <b className="split-time">{formatTime(split.seconds)}</b>
            <span className={`split-delta ${delta === null ? '' : delta <= 0 ? 'is-better' : 'is-worse'}`}>
              {delta === null ? '—' : formatDelta(delta, (value) => `${value.toFixed(2)}s`)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Names the day's rules and what to bring for them, since that is the whole point. */
export function ModifierBrief({ modifier }: { modifier: RunModifier }) {
  return (
    <div className="modifier-brief">
      <div className="modifier-heading">
        <span className="micro-label">TODAY&apos;S CONTRACT</span>
        <strong>{modifier.label}</strong>
      </div>
      <p className="modifier-copy">{modifier.description}</p>
      {modifier.favouredChassis.length > 0 && (
        <div className="modifier-chassis" aria-label="Favoured chassis">
          {modifier.favouredChassis.map((chassis) => <span key={chassis}>{chassis.toUpperCase()}</span>)}
        </div>
      )}
    </div>
  );
}

/**
 * The results screen, as a sequence rather than a grid that appears all at once.
 *
 * Nothing here is new data -- the rank, the deltas, the record flags and the splits
 * were all already computed. What changes is the order they arrive in: lines shear
 * in one after another, the headline numbers count onto their values, the rank slams
 * in oversized and settles, and the record flag stamps last. All of it collapses to
 * the finished state on any key or click, and none of it runs at all under reduced
 * motion.
 */
function CompletionState({ snapshot, level, result, modifier, reducedMotion, onExit }: {
  snapshot: SimulationSnapshot;
  level: RuntimeLevelV1;
  result: RecordedRun | null;
  modifier: RunModifier | null;
  reducedMotion: boolean;
  onExit: () => void;
}) {
  const run = result?.run;
  const previous = result?.previousBest ?? null;
  const scoreDelta = previous ? snapshot.player.score - previous.score : null;
  const timeDelta = previous ? snapshot.elapsedSeconds - previous.timeSeconds : null;
  const sequence = useRevealSequence(reducedMotion, resultsSequenceSeconds());
  // Once, on arrival, and not tied to the reveal: the stinger is the screen saying
  // the run is graded, which is true whether or not the lines are animating.
  useEffect(() => { playUiCue('result'); }, []);

  const health = Math.max(0, Math.ceil(snapshot.player.health));
  // Each figure counts up behind the line that carries it, so a number never runs
  // while the row it belongs to is still off-frame.
  const elapsed = countTo(snapshot.elapsedSeconds, sequence, stepDelaySeconds(1));
  const score = Math.round(countTo(snapshot.player.score, sequence, stepDelaySeconds(1)));
  const cells: { label: string; value: string; step: number }[] = [
    { label: 'Elapsed', value: formatTime(countTo(snapshot.elapsedSeconds, sequence, stepDelaySeconds(5))), step: 5 },
    { label: 'Run score', value: Math.round(countTo(snapshot.player.score, sequence, stepDelaySeconds(6))).toLocaleString(), step: 6 },
    { label: 'Route', value: level.name, step: 7 },
    { label: 'Integrity', value: `${Math.round(countTo(health, sequence, stepDelaySeconds(8)))}%`, step: 8 },
    { label: 'Deaths', value: String(Math.round(countTo(snapshot.player.deaths, sequence, stepDelaySeconds(9)))), step: 9 },
    { label: 'Peak chain', value: String(Math.round(countTo(snapshot.player.combo.peakLinks, sequence, stepDelaySeconds(10)))), step: 10 },
  ];
  if (modifier) cells.push({ label: 'Contract', value: modifier.label, step: 11 });

  return (
    <div
      className={`overlay-state completion-state ${sequence.settled ? 'is-settled' : 'is-sequencing'}`}
      // The stagger and line durations are handed to CSS rather than written twice:
      // `content/config.ts` stays the one place the sequence's timing is stated.
      style={{ '--results-stagger': `${presentation.resultsStaggerSeconds}s`, '--results-line': `${presentation.resultsLineSeconds}s` } as CSSProperties}
    >
      <p className="completion-summary reveal-line" style={step(1)}>{formatTime(elapsed)} · {score} points</p>
      {run && (
        <div className={`run-grade grade-${run.rank}`}>
          <strong className="grade-letter reveal-slam" style={step(0)} aria-label={`Rank ${run.rank}`}>{run.rank}</strong>
          <div className="grade-copy">
            <span className="micro-label reveal-line" style={step(2)}>{result?.isBestRun ? 'NEW BEST RUN' : 'GRADED'}</span>
            {previous ? (
              <p className="grade-delta reveal-line" style={step(3)}>
                {/* Signed against the previous best, so a near miss still reads as progress. */}
                <b className={scoreDelta !== null && scoreDelta >= 0 ? 'is-better' : 'is-worse'}>{formatDelta(scoreDelta, (value) => value.toLocaleString())} pts</b>
                <b className={timeDelta !== null && timeDelta <= 0 ? 'is-better' : 'is-worse'}>{formatDelta(timeDelta, (value) => `${value.toFixed(2)}s`)}</b>
                <span>vs best ({previous.rank})</span>
              </p>
            ) : <p className="grade-delta reveal-line" style={step(3)}><span>First clear on this route</span></p>}
          </div>
          {result?.isFastest && <span className="grade-flag reveal-stamp" style={step(4)}>FASTEST</span>}
        </div>
      )}
      <dl className="completion-grid">
        {cells.map((cell) => (
          <div className="reveal-line" key={cell.label} style={step(cell.step)}>
            <dt>{cell.label}</dt><dd>{cell.value}</dd>
          </div>
        ))}
      </dl>
      {snapshot.splits.length > 0 && <SplitTable splits={snapshot.splits} reference={previous?.splits ?? []} sequenced firstStep={12} />}
      <div className="completion-stamp reveal-stamp" style={step(16)} aria-hidden="true"><span>VALIDATED</span><strong>/// CLEAR</strong></div>
      {/* Deliberately not animated. Playwright treats an element whose box is still
          moving as unstable and waits on it, and this is the button every completion
          test presses; the rows above it hold their layout from the first frame, so
          the action never shifts under the pointer. */}
      <div className="overlay-actions"><button className="primary" onClick={onExit}><span aria-hidden="true">←</span>Return to menu</button></div>
    </div>
  );
}

/** The stagger index a line reveals on, handed to CSS as a custom property. */
function step(index: number): CSSProperties {
  return { '--step': index } as CSSProperties;
}

/** Always signed, so the direction of a delta is readable without reading the label. */
function formatDelta(value: number | null, format: (magnitude: number) => string): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '±';
  return `${sign}${format(Math.abs(value))}`;
}

export function SettingsPanel({ settings, onChange }: { settings: SaveSettingsV2; onChange: (patch: Partial<SaveSettingsV2>) => void }) {
  return (
    <details className="settings-panel">
      <summary><span><i aria-hidden="true">＋</i>Camera &amp; accessibility</span></summary>
      <div className="settings-grid">
        <Range label="Sensitivity" value={settings.sensitivity} min={0.0005} max={0.006} step={0.0001} display={settings.sensitivity.toFixed(4)} onChange={(sensitivity) => onChange({ sensitivity })} />
        <Range label="Field of view" value={settings.fov} min={75} max={110} step={1} display={`${settings.fov}°`} onChange={(fov) => onChange({ fov })} />
        <Range label="Head bob" value={settings.headBob} min={0} max={1} step={0.05} display={`${Math.round(settings.headBob * 100)}%`} onChange={(headBob) => onChange({ headBob })} />
        <Range label="Camera roll" value={settings.cameraRoll} min={0} max={1} step={0.05} display={`${Math.round(settings.cameraRoll * 100)}%`} onChange={(cameraRoll) => onChange({ cameraRoll })} />
        <Range label="Screen shake" value={settings.shake} min={0} max={1} step={0.05} display={`${Math.round(settings.shake * 100)}%`} onChange={(shake) => onChange({ shake })} />
        <Range label="Render scale" value={settings.renderScale} min={0.6} max={1} step={0.05} display={`${Math.round(settings.renderScale * 100)}%`} onChange={(renderScale) => onChange({ renderScale })} />
        <label className="setting-control graphics-quality"><span><span>Graphics quality</span><b>{settings.graphicsQuality.toUpperCase()}</b></span><select aria-label="Graphics quality" value={settings.graphicsQuality} onChange={(event) => onChange({ graphicsQuality: event.target.value as SaveSettingsV2['graphicsQuality'] })}><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label className={`toggle-row ${settings.dynamicResolution ? 'is-enabled' : ''}`}><span>Dynamic resolution<b>{settings.dynamicResolution ? 'ON' : 'OFF'}</b></span><input aria-label="Dynamic resolution" type="checkbox" checked={settings.dynamicResolution} onChange={(event) => onChange({ dynamicResolution: event.target.checked })} /><i aria-hidden="true" /></label>
        <label className={`toggle-row ${settings.reducedMotion ? 'is-enabled' : ''}`}><span>Reduced motion<b>{settings.reducedMotion ? 'ON' : 'OFF'}</b></span><input aria-label="Reduced motion" type="checkbox" checked={settings.reducedMotion} onChange={(event) => onChange({ reducedMotion: event.target.checked })} /><i aria-hidden="true" /></label>
      </div>
      <div className="settings-footer">
        <span><i />Applies immediately</span>
        <button onClick={() => onChange({ headBob: 0, cameraRoll: 0, shake: 0, reducedMotion: true })}>Reduced motion preset</button>
      </div>
    </details>
  );
}

function Range({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (value: number) => void }) {
  return <label className="setting-control"><span><span>{label}</span><b>{display}</b></span><input aria-label={label} type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
