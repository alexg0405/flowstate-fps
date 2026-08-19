import { useState } from 'react';
import type { RunModifier, RuntimeLevelV1, SaveDataV4, SaveSettingsV2, SimulationSnapshot } from '../contracts';
import type { RecordedRun } from '../persistence/saveStore';
import { UiPanel } from '../ui/Primitives';
import { WeaponBuilder } from '../ui/WeaponBuilder';
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
          <WeaponBuilder save={save} onChange={onSaveChange} onClose={() => setBuilderOpen(false)} deferredNotice />
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
          <CompletionState snapshot={snapshot} level={level} result={result ?? null} modifier={modifier} onExit={onExit} />
        ) : !loading ? (
          <div className="overlay-state standby-state">
            <p className="state-deck">Input is released. Click back in to restore movement and combat.</p>
            <div className="run-brief">
              <div><span className="micro-label">ROUTE</span><strong>{level.name}</strong></div>
              <div><span className="micro-label">ARENAS</span><strong>{Math.max(1, level.encounters.length).toString().padStart(2, '0')}</strong></div>
            </div>
            {modifier && <ModifierBrief modifier={modifier} />}
            <div className="guide-heading"><span>Controls</span></div>
            <div className="control-guide">
              <span><kbd>WASD</kbd> MOVE</span>
              <span><kbd>SPACE</kbd> JUMP</span>
              <span><kbd>SPACE ×2</kbd> DASH</span>
              <span><kbd>F</kbd> HOOK</span>
              <span><kbd>Q</kbd> PULL</span>
              <span><kbd>SPACE</kbd> WALL JUMP</span>
              <span><kbd>C</kbd> SLIDE</span>
              <span><kbd>E</kbd> MELEE</span>
              <span><kbd>R</kbd> RELOAD</span>
              <span><kbd>LMB</kbd> FIRE</span>
              <span><kbd>RMB</kbd> ADS LOCK</span>
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

function CompletionState({ snapshot, level, result, modifier, onExit }: {
  snapshot: SimulationSnapshot;
  level: RuntimeLevelV1;
  result: RecordedRun | null;
  modifier: RunModifier | null;
  onExit: () => void;
}) {
  const run = result?.run;
  const previous = result?.previousBest ?? null;
  const scoreDelta = previous ? snapshot.player.score - previous.score : null;
  const timeDelta = previous ? snapshot.elapsedSeconds - previous.timeSeconds : null;

  return (
    <div className="overlay-state completion-state">
      <p className="completion-summary">{formatTime(snapshot.elapsedSeconds)} · {snapshot.player.score} points</p>
      {run && (
        <div className={`run-grade grade-${run.rank}`}>
          <strong className="grade-letter" aria-label={`Rank ${run.rank}`}>{run.rank}</strong>
          <div className="grade-copy">
            <span className="micro-label">{result?.isBestRun ? 'NEW BEST RUN' : 'GRADED'}</span>
            {previous ? (
              <p className="grade-delta">
                {/* Signed against the previous best, so a near miss still reads as progress. */}
                <b className={scoreDelta !== null && scoreDelta >= 0 ? 'is-better' : 'is-worse'}>{formatDelta(scoreDelta, (value) => value.toLocaleString())} pts</b>
                <b className={timeDelta !== null && timeDelta <= 0 ? 'is-better' : 'is-worse'}>{formatDelta(timeDelta, (value) => `${value.toFixed(2)}s`)}</b>
                <span>vs best ({previous.rank})</span>
              </p>
            ) : <p className="grade-delta"><span>First clear on this route</span></p>}
          </div>
          {result?.isFastest && <span className="grade-flag">FASTEST</span>}
        </div>
      )}
      <dl className="completion-grid">
        <div><dt>Elapsed</dt><dd>{formatTime(snapshot.elapsedSeconds)}</dd></div>
        <div><dt>Run score</dt><dd>{snapshot.player.score.toLocaleString()}</dd></div>
        <div><dt>Route</dt><dd>{level.name}</dd></div>
        <div><dt>Integrity</dt><dd>{Math.max(0, Math.ceil(snapshot.player.health))}%</dd></div>
        <div><dt>Deaths</dt><dd>{snapshot.player.deaths}</dd></div>
        <div><dt>Peak chain</dt><dd>{snapshot.player.combo.peakLinks}</dd></div>
        {modifier && <div><dt>Contract</dt><dd>{modifier.label}</dd></div>}
      </dl>
      {snapshot.splits.length > 0 && (
        <div className="split-table" aria-label="Checkpoint splits">
          <div className="guide-heading"><span>Splits</span></div>
          {snapshot.splits.map((split) => {
            const reference = previous?.splits.find((candidate) => candidate.encounterId === split.encounterId);
            const delta = reference ? split.seconds - reference.seconds : null;
            return (
              <div className="split-row" key={split.encounterId}>
                <span className="split-label">{split.label}</span>
                <b className="split-time">{formatTime(split.seconds)}</b>
                <span className={`split-delta ${delta === null ? '' : delta <= 0 ? 'is-better' : 'is-worse'}`}>
                  {delta === null ? '—' : formatDelta(delta, (value) => `${value.toFixed(2)}s`)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="completion-stamp" aria-hidden="true"><span>VALIDATED</span><strong>/// CLEAR</strong></div>
      <div className="overlay-actions"><button className="primary" onClick={onExit}><span aria-hidden="true">←</span>Return to menu</button></div>
    </div>
  );
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
