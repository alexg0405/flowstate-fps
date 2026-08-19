import { lazy, Suspense, useState } from 'react';
import type { RuntimeLevelV1, SaveDataV4 } from './contracts';
import { cookLevel, defaultLevel } from './content/defaultLevel';
import { modifierForDate } from './content/modifiers';
import { formatTime } from './game/format';
import { loadSave, writeSave } from './persistence/saveStore';
import { WeaponBuilder } from './ui/WeaponBuilder';

const EditorScreen = lazy(() => import('./editor/EditorScreen').then((module) => ({ default: module.EditorScreen })));
const GameScreen = lazy(() => import('./game/GameScreen').then((module) => ({ default: module.GameScreen })));

type AppMode = 'menu' | 'game' | 'editor' | 'builder';

export function App() {
  const initialMode = new URLSearchParams(location.search).get('mode');
  const [mode, setMode] = useState<AppMode>(initialMode === 'editor' || initialMode === 'game' ? initialMode : 'menu');
  const [level, setLevel] = useState<RuntimeLevelV1>(initialRuntimeLevel);

  if (mode === 'game') {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <GameScreen level={level} onExit={() => setMode('menu')} />
      </Suspense>
    );
  }

  if (mode === 'editor') {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <EditorScreen
          onPlay={(next) => {
            setLevel(next);
            setMode('game');
          }}
          onExit={() => setMode('menu')}
        />
      </Suspense>
    );
  }

  if (mode === 'builder') {
    return (
      <main className="builder-shell">
        <BuilderRoute onClose={() => setMode('menu')} />
      </main>
    );
  }

  return (
    <MainMenu
      onPlay={() => {
        setLevel(cookLevel(defaultLevel));
        setMode('game');
      }}
      onEdit={() => setMode('editor')}
      onBuild={() => setMode('builder')}
    />
  );
}

/** Owns the save while the builder is open so edits persist immediately. */
function BuilderRoute({ onClose }: { onClose: () => void }) {
  const [save, setSave] = useState(loadSave);
  return (
    <WeaponBuilder
      save={save}
      onChange={(next: SaveDataV4) => {
        setSave(next);
        writeSave(next);
      }}
      onClose={onClose}
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
  if (scene !== 'hunters') return level;
  level.spawns = level.spawns.map((spawn) => {
    if (spawn.kind === 'player') return { ...spawn, position: [0, 3.1, -35.5] };
    if (spawn.id === 'bot-a') return { ...spawn, position: [-2.6, 3, -42] };
    if (spawn.id === 'bot-b') return { ...spawn, position: [2.6, 3, -42] };
    return spawn;
  });
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
          Dash. Break gravity. Cast the line. A precision movement FPS drawn in speed, neon, and momentum.
        </p>

        <ul className="protocol-strip" aria-label="Core movement systems">
          <li><b>01</b><span>Dash chain</span><i aria-hidden="true" /></li>
          <li><b>02</b><span>Grapple cast</span><i aria-hidden="true" /></li>
          <li><b>03</b><span>Wall running</span><i aria-hidden="true" /></li>
        </ul>

        <div className="menu-contract" aria-label="Today's contract">
          <div className="contract-heading">
            <span className="micro-label">TODAY&apos;S CONTRACT</span>
            <strong>{modifier.label}</strong>
          </div>
          <p>{modifier.description}</p>
          {modifier.favouredChassis.length > 0 && (
            <div className="modifier-chassis">
              {modifier.favouredChassis.map((chassis) => <span key={chassis}>{chassis.toUpperCase()}</span>)}
            </div>
          )}
        </div>

        <div className="menu-actions">
          <button className="primary jumbo action-primary" aria-label="Run White Line" onClick={onPlay}>
            <span className="action-copy"><strong>Run White Line</strong></span>
            <span className="action-glyph" aria-hidden="true">↗</span>
          </button>
          <button className="jumbo ghost action-secondary" aria-label="Open gun builder" onClick={onBuild}>
            <span className="action-copy"><strong>Gun builder</strong></span>
            <span className="action-glyph" aria-hidden="true">⚙</span>
          </button>
          <button className="jumbo ghost action-secondary" aria-label="Open gameplay editor" onClick={onEdit}>
            <span className="action-copy"><strong>Gameplay editor</strong></span>
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
