import { useEffect, useRef, useState } from 'react';
import type { RuntimeLevelV1, SaveDataV6, SaveSettingsV3 } from '../contracts';
import { setInterfaceVolume } from '../audio/interfaceAudio';
import { modifierForDate } from '../content/modifiers';
import { GameRuntime, type RuntimeUpdate } from '../runtime/GameRuntime';
import { loadoutBuilds, loadSave, recordRun, writeSave, type RecordedRun } from '../persistence/saveStore';
import { GameOverlay, type ScreenState } from './GameOverlay';
import { Hud } from './Hud';

interface GameScreenProps {
  level: RuntimeLevelV1;
  onExit: () => void;
}

export function GameScreen({ level, onExit }: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<GameRuntime | null>(null);
  const completedRecorded = useRef(false);
  const [update, setUpdate] = useState<RuntimeUpdate | null>(null);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState(loadSave);
  const [result, setResult] = useState<RecordedRun | null>(null);
  // Fixed for the lifetime of the screen, so a run cannot change rules at midnight.
  const modifierRef = useRef(modifierForDate(new Date()));
  const modifier = modifierRef.current;
  const debug = save.settings.debug;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let runtime: GameRuntime;
    try {
      // Read once at construction: swapping the ghost mid-run would move the racer
      // the player is measuring themselves against.
      runtime = new GameRuntime(
        canvas,
        setUpdate,
        setLocked,
        save.settings,
        loadoutBuilds(save),
        // Only race a path set under the same rules; a modifier changes what the route
        // is worth and how hard it pushes back.
        save.bestRun?.modifierId === modifier.id ? save.bestRun?.ghost : undefined,
        modifier,
        save.blade,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
      return;
    }
    runtimeRef.current = runtime;
    runtime.initialize(level).then(() => {
      if (!cancelled) setLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => {
      cancelled = true;
      runtime.dispose();
    };
  }, [level]); // Settings updates are applied through updateSettings without recreating WebGL/Rapier.

  const snapshot = update?.snapshot;
  useEffect(() => {
    if (!snapshot?.completed || completedRecorded.current) return;
    completedRecorded.current = true;
    // The grade, the previous best and the record flags were previously computed and
    // then thrown away, so the completion screen could not report any of them.
    const recorded = recordRun(
      loadSave(),
      snapshot.elapsedSeconds,
      snapshot.player.score,
      snapshot.player.deaths,
      snapshot.splits,
      snapshot.player.combo.peakLinks,
      runtimeRef.current?.ghostTrack() ?? undefined,
      modifier.id,
    );
    setResult(recorded);
    setSave(recorded.save);
  }, [snapshot]);

  const enter = async () => {
    try {
      await runtimeRef.current?.startInput();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const updateSettings = (patch: Partial<SaveSettingsV3>) => {
    const next: SaveDataV6 = { ...save, settings: { ...save.settings, ...patch } };
    setSave(next);
    writeSave(next);
    runtimeRef.current?.updateSettings(next.settings);
    // The interface keeps its own bus, so the pause card's slider has to reach both or
    // the menu the player backs out to is still at the old level.
    setInterfaceVolume(next.settings.volume);
  };

  const screenState: ScreenState = error
    ? 'fault'
    : snapshot?.completed
      ? 'complete'
      : loading
        ? 'booting'
        : locked
          ? 'active'
          : 'standby';

  return (
    <main className={`game-shell state-${screenState} ${save.settings.reducedMotion ? 'reduced-motion' : ''}`}>
      <canvas ref={canvasRef} className="game-canvas" aria-label="Flow State FPS game canvas" />
      <div className="game-chrome" aria-hidden="true">
        <span className="chrome-corner chrome-corner-nw" />
        <span className="chrome-corner chrome-corner-ne" />
        <span className="chrome-corner chrome-corner-sw" />
        <span className="chrome-corner chrome-corner-se" />
        <div className="scanline-field" />
        <div className="visor-noise" />
      </div>
      {snapshot && <Hud snapshot={snapshot} hits={update?.hits} damage={update?.damage} ghost={update?.ghost} ovation={update?.ovation} dodge={update?.dodge} modifier={modifier} />}
      {debug && update && <DebugPanel update={update} />}
      <div className="top-actions" role="toolbar" aria-label="Run controls">
        <span className="run-link-status" aria-hidden="true"><i />SIM/LINK</span>
        <button className={`utility-action ${debug ? 'is-active' : ''}`} onClick={() => updateSettings({ debug: !debug })}>
          <span aria-hidden="true">{debug ? '◉' : '◎'}</span>{debug ? 'Hide debug' : 'Debug'}
        </button>
        <button className="utility-action exit-action" onClick={onExit}><span aria-hidden="true">×</span>Exit</button>
      </div>
      {screenState !== 'active' && (
        <GameOverlay
          screenState={screenState}
          error={error}
          snapshot={snapshot}
          level={level}
          settings={save.settings}
          save={save}
          result={result}
          modifier={modifier}
          onSaveChange={(next) => {
            setSave(next);
            writeSave(next);
          }}
          onSettingsChange={updateSettings}
          onEnter={enter}
          onExit={onExit}
        />
      )}
    </main>
  );
}

function DebugPanel({ update }: { update: RuntimeUpdate }) {
  const { snapshot, stats } = update;
  return (
    <aside className="debug-panel" aria-label="Runtime telemetry">
      <header><span><i />LIVE TELEMETRY</span><b>DEV//TRACE</b></header>
      <pre>{[
        `tick       ${snapshot.tick}`,
        `state      ${snapshot.player.locomotion} / ${snapshot.player.action}`,
        // Where the player actually is. Authoring or driving a route without this
        // means guessing from the view, and a run that falls off the level looks
        // exactly like one that stopped against a lip.
        `position   ${(snapshot.entities[0]?.position ?? [0, 0, 0]).map((axis) => axis.toFixed(1)).join(' ')}`,
        `speed      ${snapshot.player.speed.toFixed(2)} m/s`,
        `air charge ${snapshot.player.airCharge}`,
        `dodge      ${snapshot.player.dodge.invulnerable ? 'INVULNERABLE' : snapshot.player.dodge.ready ? 'ready' : `${snapshot.player.dodge.cooldown.toFixed(2)} s`}`,
        `deaths     ${snapshot.player.deaths}${snapshot.player.awaitingRespawn ? ' (down)' : ''}`,
        `chain      ${snapshot.player.combo.links} x${snapshot.player.combo.multiplier.toFixed(1)} (peak ${snapshot.player.combo.peakLinks})`,
        `ghost      ${update.ghost?.deltaSeconds === undefined || update.ghost?.deltaSeconds === null ? 'none' : `${update.ghost.deltaSeconds >= 0 ? '+' : ''}${update.ghost.deltaSeconds.toFixed(2)}s`}`,
        `grapple    ${snapshot.player.grapple.active ? `${snapshot.player.grapple.ropeLength.toFixed(2)} m` : `cooldown ${snapshot.player.grapple.cooldown.toFixed(2)}`}`,
        `frame      ${stats.frameMs.toFixed(2)} ms`,
        `hitstop    ${stats.hitstopSeconds > 0 ? `${(stats.hitstopSeconds * 1000).toFixed(0)} ms` : 'clear'} / ${stats.hitstopTotalSeconds.toFixed(2)} s total`,
        `simulation ${stats.simulationMs.toFixed(2)} ms (${stats.steps} steps)`,
        `draw calls ${stats.drawCalls}`,
        `triangles  ${stats.triangles}`,
        `render     ${(stats.renderScale * 100).toFixed(0)}%`,
        `assets CPU ${(stats.assetCpuBytes / 1_048_576).toFixed(2)} MB`,
        `assets GPU ${(stats.assetGpuBytes / 1_048_576).toFixed(2)} MB`,
        `entities   ${snapshot.entities.length}`,
      ].join('\n')}</pre>
      <footer><span>60HZ TARGET</span><i /><span>ESC // RELEASE</span></footer>
    </aside>
  );
}
