import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { RuntimeLevelV1, SaveDataV6, SpawnDefinition } from './contracts';
import { installInterfaceAudio, setInterfaceVolume } from './audio/interfaceAudio';
import { cookLevel, defaultLevel } from './content/defaultLevel';
import { modifierForDate } from './content/modifiers';
import { formatTime } from './game/format';
import { loadSave, writeSave } from './persistence/saveStore';
import { ScreenWipe } from './ui/ScreenWipe';
import { WeaponBuilder } from './ui/WeaponBuilder';

const EditorScreen = lazy(() => import('./editor/EditorScreen').then((module) => ({ default: module.EditorScreen })));
const GameScreen = lazy(() => import('./game/GameScreen').then((module) => ({ default: module.GameScreen })));

type AppMode = 'menu' | 'game' | 'editor' | 'builder';

export function App() {
  const initialMode = new URLSearchParams(location.search).get('mode');
  const [mode, setMode] = useState<AppMode>(initialMode === 'editor' || initialMode === 'game' ? initialMode : 'menu');
  const [level, setLevel] = useState<RuntimeLevelV1>(initialRuntimeLevel);
  // Null when no wipe is playing; otherwise a key that changes per transition so the
  // CSS animation restarts even on two moves in a row.
  const [wipe, setWipe] = useState<number | null>(null);
  // Re-read on every move rather than held from the first render: the pause screen
  // and the bench can both change the setting while a screen is open.
  const [reducedMotion, setReducedMotion] = useState(() => loadSave().settings.reducedMotion);

  // Installed once for the whole interface: hover, confirm, cancel and select are
  // delegated from the document rather than threaded through every screen.
  useEffect(installInterfaceAudio, []);

  // The interface bus outlives every run, so it is told the level here as well as by
  // `GameRuntime`. Re-read on each move for the same reason `reducedMotion` is: the
  // pause card can change it while a run is open.
  useEffect(() => { setInterfaceVolume(loadSave().settings.volume); }, [mode]);

  useEffect(() => {
    // `game-shell` already carries this while a run is open, but the menu, the bench
    // and the wipe itself sit outside it. On the root element it reaches every screen,
    // which matters because `reducedMotion` is a save toggle as well as a media query.
    document.documentElement.classList.toggle('reduced-motion', reducedMotion);
  }, [reducedMotion]);

  /**
   * The single seam between screens. The new screen is set immediately -- nothing
   * here waits on the transition -- and the wipe is raised alongside it.
   */
  const go = (next: AppMode) => {
    if (next === mode) return;
    const settled = loadSave().settings.reducedMotion;
    setReducedMotion(settled);
    if (!settled) setWipe((key) => (key ?? 0) + 1);
    setMode(next);
  };
  const clearWipe = useCallback(() => setWipe(null), []);

  const screen = (() => {
    if (mode === 'game') {
      return (
        <Suspense fallback={<LoadingScreen />}>
          <GameScreen level={level} onExit={() => go('menu')} />
        </Suspense>
      );
    }
    if (mode === 'editor') {
      return (
        <Suspense fallback={<LoadingScreen />}>
          <EditorScreen
            onPlay={(next) => {
              setLevel(next);
              go('game');
            }}
            onExit={() => go('menu')}
          />
        </Suspense>
      );
    }
    if (mode === 'builder') {
      return (
        <main className="builder-shell">
          <BuilderRoute onClose={() => go('menu')} />
        </main>
      );
    }
    return (
      <MainMenu
        onPlay={() => {
          setLevel(cookLevel(defaultLevel));
          go('game');
        }}
        onEdit={() => go('editor')}
        onBuild={() => go('builder')}
      />
    );
  })();

  return (
    <>
      {screen}
      {wipe !== null && <ScreenWipe key={wipe} onDone={clearWipe} />}
    </>
  );
}

/** Owns the save while the builder is open so edits persist immediately. */
function BuilderRoute({ onClose }: { onClose: () => void }) {
  const [save, setSave] = useState(loadSave);
  return (
    <WeaponBuilder
      save={save}
      onChange={(next: SaveDataV6) => {
        setSave(next);
        writeSave(next);
      }}
      onClose={onClose}
      reducedMotion={save.settings.reducedMotion}
    />
  );
}

function initialRuntimeLevel(): RuntimeLevelV1 {
  const level = cookLevel(defaultLevel);
  const scene = new URLSearchParams(location.search).get('scene');
  // `finish` drops the encounter chain and starts on the exit pad so the
  // completion presentation is reachable in a single browser test step.
  if (scene === 'finish') {
    level.encounters = [];
    level.spawns = level.spawns
      .filter((spawn) => spawn.kind === 'player')
      .map((spawn) => ({ ...spawn, position: [level.exit[0], level.exit[1], level.exit[2]] as const }));
    return level;
  }
  // `hunters` stages one pair in front of the camera for the character baseline. It
  // rebuilds the roster rather than repositioning named spawns, which is what it used to
  // do: the ids it reached for stopped existing when the arenas were re-authored, and a
  // scene that silently stages nothing is a pixel baseline that silently stops testing
  // the thing it is named after.
  if (scene === 'hunters') {
    const player = level.spawns.find((spawn) => spawn.kind === 'player')!;
    level.encounters = [];
    level.spawns = [
      { ...player, position: [0, 3.1, -35.5] },
      { id: 'hunter-ranged', kind: 'bot-ranged', position: [-2.6, 3, -42], rotationY: 0 },
      { id: 'hunter-brawler', kind: 'bot-aggressive', position: [2.6, 3, -42], rotationY: 0 },
    ];
    return level;
  }
  // `crowd` stages the biggest wave the route authors, in an arc, all at once and with
  // no encounter gating -- so the worst frame the shipped content can produce is
  // reachable in one browser step instead of two cleared arenas away.
  if (scene === 'crowd') {
    const player = level.spawns.find((spawn) => spawn.kind === 'player')!;
    const roster: SpawnDefinition['kind'][] = [
      'bot-bulwark', 'bot-aggressive', 'bot-aggressive', 'bot-aggressive',
      'bot-aggressive', 'bot-aggressive', 'bot-ranged', 'bot-ranged',
    ];
    level.encounters = [];
    level.spawns = [
      { ...player, position: [0, 11.1, -137] },
      ...roster.map((kind, index) => {
        const angle = -0.7 + (index / (roster.length - 1)) * 1.4;
        return {
          id: `crowd-${index}`,
          kind,
          position: [Math.sin(angle) * 9, 11.5, -145 - Math.cos(angle) * 4] as const,
          rotationY: 0,
        };
      }),
    ];
    return level;
  }
  return level;
}

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-label="Loading Flow State" aria-busy="true">
      <div className="boot-backdrop" aria-hidden="true">
        <i className="boot-grid" />
        <i className="boot-scanline" />
        <i className="boot-flare boot-flare-a" />
        <i className="boot-flare boot-flare-b" />
      </div>

      <section className="boot-console" aria-live="polite">
        <div className="boot-readout">
          <strong>FLOW STATE</strong>
          <div className="loading-track" role="progressbar" aria-label="Loading game systems">
            <div className="loading-bar" />
          </div>
          <p className="boot-kicker">Loading</p>
        </div>
      </section>
    </main>
  );
}

function MainMenu({ onPlay, onEdit, onBuild }: { onPlay: () => void; onEdit: () => void; onBuild: () => void }) {
  const save = loadSave();
  const best = save.bestRun;
  const modifier = modifierForDate(new Date());
  // The fastest clear is often a different attempt from the highest scoring one, so
  // it is called out separately instead of being folded into the record card.
  const fastest = save.bestTimeSeconds;
  const showsSeparateFastest = fastest !== null && best !== null && fastest < best.timeSeconds;
  const routeName = defaultLevel.name;

  return (
    <main className="menu-shell" aria-labelledby="menu-title">
      <div className="menu-atmosphere" aria-hidden="true">
        <div className="menu-grid" />
        <div className="menu-scanlines" />
        <div className="menu-noise" />
        <div className="menu-glow menu-glow-cyan" />
        <div className="menu-glow menu-glow-red" />
        <div className="menu-horizon"><i /><i /><i /></div>
        <div className="menu-cityline">
          <i className="city-block city-block-01" />
          <i className="city-block city-block-02" />
          <i className="city-block city-block-03" />
          <i className="city-block city-block-04" />
          <i className="city-block city-block-05" />
          <i className="city-block city-block-06" />
        </div>
      </div>

      <header className="menu-chrome">
        <div className="menu-brand" aria-label="Flow State">
          <b className="menu-brand-mark" aria-hidden="true">F<span>/</span>S</b>
        </div>
      </header>

      <section className="menu-copy">
        <div className="menu-title-lockup">
          <h1 id="menu-title" aria-label="FLOW STATE">
            <span>FLOW</span>
            <em>STATE</em>
          </h1>
        </div>

        <p className="menu-deck">
          A first-person movement shooter. Chain dashes, wall runs and grapple lines along a neon
          rooftop route, clear the arenas in your way, and race the ghost of your best run.
        </p>

        <div className="menu-contract" aria-label="Today's contract">
          <div className="contract-heading">
            <span className="micro-label">TODAY&apos;S CONTRACT</span>
            <strong>{modifier.label}</strong>
            <small>New rules daily</small>
          </div>
          <p>{modifier.description}</p>
          {modifier.favouredChassis.length > 0 && (
            <div className="modifier-chassis">
              {modifier.favouredChassis.map((chassis) => <span key={chassis}>{chassis.toUpperCase()}</span>)}
            </div>
          )}
        </div>

        <div className="menu-actions">
          <button className="primary jumbo action-primary" aria-label="Start run on the White Line route" onClick={onPlay}>
            <span className="action-copy"><strong>Start run</strong><small>{routeName}</small></span>
            <span className="action-glyph" aria-hidden="true">↗</span>
          </button>
          <button className="jumbo ghost action-secondary" aria-label="Open gun builder" onClick={onBuild}>
            <span className="action-copy"><strong>Gun builder</strong><small>Fit the two guns you carry</small></span>
            <span className="action-glyph" aria-hidden="true">⚙</span>
          </button>
          <button className="jumbo ghost action-secondary" aria-label="Open gameplay editor" onClick={onEdit}>
            <span className="action-copy"><strong>Gameplay editor</strong><small>Build your own route</small></span>
            <span className="action-glyph" aria-hidden="true">＋</span>
          </button>
        </div>
      </section>

      <aside className={`run-record glass-card ${best ? 'has-record' : 'no-record'}`} aria-label="Personal record">
        <header>
          <p>BEST RUN</p>
          {best && <span className="record-rank" aria-label={`Rank ${best.rank}`}>{best.rank}</span>}
        </header>

        {best ? (
          <>
            <div className="record-time"><strong>{formatTime(best.timeSeconds)}</strong></div>
            <dl className="record-stats">
              <div><dt>Score</dt><dd>{best.score.toLocaleString()}</dd></div>
              <div><dt>Deaths</dt><dd>{best.deaths}</dd></div>
              <div><dt>Chain</dt><dd>{best.peakCombo}</dd></div>
              {showsSeparateFastest && <div><dt>Fastest</dt><dd>{formatTime(fastest)}</dd></div>}
            </dl>
          </>
        ) : (
          <p className="record-empty">No runs yet</p>
        )}
      </aside>

      <footer className="menu-footer">
        <span className="footer-controls"><kbd>WASD</kbd> MOVE <i /> <kbd>SPACE ×2</kbd> DASH <i /> <kbd>F</kbd> GRAPPLE</span>
      </footer>

      <div className="menu-corner menu-corner-tl" aria-hidden="true" />
      <div className="menu-corner menu-corner-tr" aria-hidden="true" />
      <div className="menu-corner menu-corner-bl" aria-hidden="true" />
      <div className="menu-corner menu-corner-br" aria-hidden="true" />
    </main>
  );
}
