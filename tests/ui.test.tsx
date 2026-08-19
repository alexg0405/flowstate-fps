import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveDataV4, SaveSettingsV2, SimulationSnapshot } from '../src/contracts';
import { cookLevel, defaultLevel } from '../src/content/defaultLevel';
import { defaultArmory } from '../src/content/weapons';
import { GameOverlay, SettingsPanel } from '../src/game/GameOverlay';
import { Hud } from '../src/game/Hud';
import { migrateSaveData } from '../src/persistence/saveStore';
import { Section, Tabs, Tooltip } from '../src/ui/Primitives';
import { WeaponBuilder } from '../src/ui/WeaponBuilder';
import { resolveWeaponStats } from '../src/content/weapons';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

/**
 * React tracks the value of controlled fields, so a plain assignment is ignored.
 * Going through the native setter makes the change visible to React's onChange.
 */
function setFieldValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  act(() => element.dispatchEvent(new Event('change', { bubbles: true })));
}

function query(selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Expected the DOM to contain "${selector}".`);
  return element;
}

function snapshotFixture(overrides: Partial<SimulationSnapshot['player']> = {}, snapshot: Partial<SimulationSnapshot> = {}): SimulationSnapshot {
  return {
    tick: 120,
    elapsedSeconds: 73.5,
    entities: [{ id: 1, kind: 'player', position: [0, 1, 0], velocity: [0, 0, 0], rotationY: 0, grounded: true, aimPitch: 0, health: 100 }],
    camera: { position: [0, 1.58, 0], yaw: 0, pitch: 0, fov: 92 },
    player: {
      health: 100,
      ammo: 24,
      reserveAmmo: 119,
      magazineSize: 30,
      weapons: { activeSlot: 0, ready: true, slots: [
        { name: 'Carbine', chassisId: 'carbine' as const, parts: {}, ammo: 30, reserveAmmo: 120 },
        { name: 'SMG', chassisId: 'smg' as const, parts: {}, ammo: 40, reserveAmmo: 180 },
      ] },
      locomotion: 'grounded',
      action: 'neutral',
      adsProgress: 0,
      actionProgress: 0,
      spreadBloom: 0,
      stance: 0,
      speed: 8.4,
      airCharge: 1,
      grapple: { active: false, anchor: null, ropeLength: 0, cooldown: 0, available: true, aim: null },
      dashAvailable: true,
      jumpCancelAvailable: false,
      wallJumpAvailable: false,
      lockedTargetId: null,
      score: 1250,
      combo: { links: 0, multiplier: 1, window: 0, peakLinks: 0 },
      deaths: 0,
      awaitingRespawn: false,
      ...overrides,
    },
    splits: [],
    objective: 'Clear: Atrium',
    completed: false,
    openGateIds: [],
    ...snapshot,
  };
}

function saveFixture(): SaveDataV4 {
  const armory = defaultArmory();
  return {
    schemaVersion: 4,
    settings: settingsFixture,
    bestRun: null,
    bestTimeSeconds: null,
    armory,
    loadout: [armory[0].id, armory[1].id],
  };
}

const settingsFixture: SaveSettingsV2 = {
  sensitivity: 0.002,
  fov: 92,
  cameraRoll: 0.65,
  headBob: 0.35,
  shake: 0.5,
  renderScale: 1,
  debug: false,
  reducedMotion: false,
  graphicsQuality: 'auto',
  dynamicResolution: true,
};

describe('HUD grapple presentation', () => {
  it('reports the armed state and a full readiness meter when the hook is available', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(query('.grapple-readout').getAttribute('aria-label')).toBe('Grapple armed');
    expect(query('.grapple-readout').className).toContain('grapple-ready');
    expect(query('.crosshair').className).toContain('hook-ready');
    expect(query('.grapple-readout > i').style.transform).toBe('scaleX(1)');
    expect(query('.chain-rail').textContent).toContain('AIR DASH READY');
  });

  it('reports rope length and a tethered crosshair while attached', () => {
    render(<Hud snapshot={snapshotFixture({
      locomotion: 'grappling',
      grapple: { active: true, anchor: [0, 14, -69], ropeLength: 18.42, cooldown: 0, available: false, aim: null },
    })} />);
    expect(query('.grapple-readout').getAttribute('aria-label')).toBe('Grapple tethered');
    expect(query('.grapple-copy').textContent).toContain('Q · PULL 18M');
    expect(query('.crosshair').className).toContain('locked');
    expect(query('.hud').className).toContain('is-grappling');
    expect(query('.chain-rail').textContent).toContain('HOOKED');
  });

  it('drains the cooldown meter proportionally while relinking', () => {
    render(<Hud snapshot={snapshotFixture({
      grapple: { active: false, anchor: null, ropeLength: 0, cooldown: 0.175, available: false, aim: null },
    })} />);
    expect(query('.grapple-readout').getAttribute('aria-label')).toBe('Grapple relink');
    expect(query('.grapple-readout > i').style.transform).toBe('scaleX(0.5)');
    expect(query('.crosshair').className).toContain('cooldown');
  });

  it('marks each movement-chain step from the snapshot availability flags', () => {
    render(<Hud snapshot={snapshotFixture({
      dashAvailable: false,
      jumpCancelAvailable: true,
      airCharge: 0,
      wallJumpAvailable: false,
      grapple: { active: false, anchor: null, ropeLength: 0, cooldown: 0.2, available: false, aim: null },
    })} />);
    const steps = [...container.querySelectorAll('.chain-step')].map((step) => step.className.includes('is-ready'));
    expect(steps).toEqual([false, true, false, false, false]);
    expect(query('.chain-rail').textContent).toContain('TOUCH GROUND OR WALL TO RECHARGE');
  });

  it('advertises the wall-jump window ahead of the air-charge prompt', () => {
    render(<Hud snapshot={snapshotFixture({ airCharge: 0, wallJumpAvailable: true })} />);
    const steps = [...container.querySelectorAll('.chain-step')].map((step) => step.className.includes('is-ready'));
    expect(steps[3]).toBe(true);
    expect(query('.chain-rail').textContent).toContain('WALL CONTACT');
  });

  it('shows the ADS lock indicator only while a target is tracked', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(container.querySelector('.lock-indicator')).toBeNull();
    expect(query('.crosshair').className).not.toContain('target-locked');

    render(<Hud snapshot={snapshotFixture({ lockedTargetId: 4 })} />);
    expect(query('.lock-indicator').getAttribute('aria-label')).toBe('Target locked');
    expect(query('.lock-indicator').textContent).toContain('LOCK');
    expect(query('.crosshair').className).toContain('target-locked');
  });

  it('escalates the vitals module when health drops into the critical band', () => {
    render(<Hud snapshot={snapshotFixture({ health: 18 })} />);
    expect(query('.hud').className).toContain('health-critical');
    expect(query('.ui-meter').className).toContain('red');
    expect(query('.ui-meter').getAttribute('aria-label')).toBe('HP: 18 of 100');
  });
});

describe('hit feedback', () => {
  const hit = (overrides: Partial<{ id: number; screen: readonly [number, number]; amount: number; headshot: boolean; kill: boolean }> = {}) => ({
    id: 1, screen: [400, 300] as const, amount: 34, headshot: false, kill: false, ...overrides,
  });

  it('raises the down panel with the redeploy prompt while awaiting respawn', () => {
    render(<Hud snapshot={snapshotFixture({ awaitingRespawn: true, deaths: 2, health: 0 })} />);
    const panel = query('.down-panel');
    expect(panel.getAttribute('role')).toBe('alert');
    expect(query('.down-prompt').textContent).toContain('redeploy');
    // The clock cost is stated, so the player knows what the death actually charged.
    expect(query('.down-cost').textContent).toContain('Death 2');
    expect(query('.hud').className).toContain('is-down');
  });

  it('hides the down panel while the player is alive', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(container.querySelector('.down-panel')).toBeNull();
    expect(query('.hud').className).not.toContain('is-down');
  });

  it('reports the run death count and flags it once it is non-zero', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(query('.run-deaths').className).not.toContain('has-deaths');
    render(<Hud snapshot={snapshotFixture({ deaths: 3 })} />);
    expect(query('.run-deaths').textContent).toContain('3');
    expect(query('.run-deaths').className).toContain('has-deaths');
  });

  it('shows the most recent checkpoint split', () => {
    render(<Hud snapshot={snapshotFixture({}, { splits: [
      { encounterId: 'arena-1', label: 'Atrium', seconds: 30.5 },
      { encounterId: 'arena-2', label: 'Gallery', seconds: 71.25 },
    ] })} />);
    const readout = query('.split-readout');
    expect(readout.textContent).toContain('GALLERY');
    expect(readout.textContent).toContain('1:11.25');
  });

  it('reports being ahead of the record as a negative delta', () => {
    render(<Hud snapshot={snapshotFixture()} ghost={{ deltaSeconds: -1.25, finished: false }} />);
    const delta = query('.ghost-delta');
    expect(delta.className).toContain('ghost-ahead');
    expect(delta.textContent).toContain('-1.25');
    expect(delta.getAttribute('aria-label')).toContain('ahead');
  });

  it('reports being behind the record as a positive delta', () => {
    render(<Hud snapshot={snapshotFixture()} ghost={{ deltaSeconds: 0.4, finished: false }} />);
    const delta = query('.ghost-delta');
    expect(delta.className).toContain('ghost-behind');
    expect(delta.textContent).toContain('+0.40');
  });

  it('shows no comparison when the route has no record yet', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(container.querySelector('.ghost-delta')).toBeNull();
    render(<Hud snapshot={snapshotFixture()} ghost={{ deltaSeconds: null, finished: false }} />);
    expect(container.querySelector('.ghost-delta')).toBeNull();
  });

  it('reports the live chain and flags it as it lapses', () => {
    render(<Hud snapshot={snapshotFixture({ combo: { links: 4, multiplier: 1.4, window: 0.8, peakLinks: 6 } })} />);
    expect(query('.combo-multiplier').textContent).toBe('×1.4');
    expect(query('.combo-links').textContent).toBe('4 LINKS');
    expect(query('.chain-rail').className).toContain('combo-live');
    expect(query('.chain-status').textContent).toContain('PEAK 6');

    render(<Hud snapshot={snapshotFixture({ combo: { links: 4, multiplier: 1.4, window: 0.2, peakLinks: 6 } })} />);
    expect(query('.chain-rail').className).toContain('combo-lapsing');
  });

  it('shows an idle chain rail with nothing chained', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(query('.chain-rail').className).toContain('combo-idle');
    expect(query('.combo-links').textContent).toBe('0 LINKS');
  });

  it('points a threat wedge back at whoever fired', () => {
    render(<Hud snapshot={snapshotFixture()} damage={[{ id: 4, bearing: Math.PI / 2, amount: 10 }]} />);
    const wedge = query('.threat-wedge');
    // A bearing of +90 degrees means the shooter is to the player's right.
    expect(wedge.style.transform).toBe('rotate(90deg)');
    expect(wedge.className).not.toContain('is-heavy');
  });

  it('escalates the wedge for a heavier hit and renders one per source', () => {
    render(<Hud snapshot={snapshotFixture()} damage={[{ id: 1, bearing: 0, amount: 14 }, { id: 2, bearing: -Math.PI, amount: 4 }]} />);
    const wedges = [...container.querySelectorAll('.threat-wedge')];
    expect(wedges).toHaveLength(2);
    expect(wedges[0].className).toContain('is-heavy');
    expect(wedges[1].className).not.toContain('is-heavy');
  });

  it('shows no wedges when nothing is shooting', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(container.querySelectorAll('.threat-wedge')).toHaveLength(0);
  });

  it('shows nothing when no hits landed this frame', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(container.querySelector('.hitmarker')).toBeNull();
    expect(container.querySelectorAll('.damage-number')).toHaveLength(0);
  });

  it('places a damage number at the projected hit position', () => {
    render(<Hud snapshot={snapshotFixture()} hits={[hit({ amount: 34, screen: [640, 220] })]} />);
    const number = query('.damage-number');
    expect(number.textContent).toBe('34');
    expect(number.style.left).toBe('640px');
    expect(number.style.top).toBe('220px');
    expect(query('.hitmarker').className).not.toContain('is-kill');
  });

  it('escalates the marker and number for headshots and kills', () => {
    render(<Hud snapshot={snapshotFixture()} hits={[hit({ id: 7, headshot: true })]} />);
    expect(query('.hitmarker').className).toContain('is-headshot');
    expect(query('.damage-number').className).toContain('is-headshot');

    render(<Hud snapshot={snapshotFixture()} hits={[hit({ id: 8, kill: true })]} />);
    expect(query('.hitmarker').className).toContain('is-kill');
    expect(query('.damage-number').className).toContain('is-kill');
  });

  it('renders one number per hit in a batch', () => {
    render(<Hud snapshot={snapshotFixture()} hits={[hit({ id: 1 }), hit({ id: 2, amount: 59 }), hit({ id: 3, amount: 12 })]} />);
    expect([...container.querySelectorAll('.damage-number')].map((node) => node.textContent)).toEqual(['34', '59', '12']);
    // Only the newest hit drives the crosshair marker.
    expect(container.querySelectorAll('.hitmarker')).toHaveLength(1);
  });
});

describe('health and ammo emphasis', () => {
  it('flags a low magazine and sizes the pip track from the real capacity', () => {
    render(<Hud snapshot={snapshotFixture({ ammo: 4, magazineSize: 30 })} />);
    expect(query('.hud').className).toContain('ammo-low');
    expect(query('.hud-ammo .module-heading').textContent).toContain('LOW');
    expect(query('.ammo-track').getAttribute('aria-label')).toBe('4 of 30 rounds in magazine');
    expect(container.querySelectorAll('.ammo-track i.is-loaded')).toHaveLength(2);
  });

  it('flags an empty magazine', () => {
    render(<Hud snapshot={snapshotFixture({ ammo: 0 })} />);
    expect(query('.hud').className).toContain('ammo-empty');
    expect(query('.hud-ammo .module-heading').textContent).toContain('EMPTY');
  });

  it('shows reload progress only while reloading', () => {
    render(<Hud snapshot={snapshotFixture({ action: 'neutral' })} />);
    expect(container.querySelector('.reload-track')).toBeNull();

    render(<Hud snapshot={snapshotFixture({ action: 'reloading', actionProgress: 0.4 })} />);
    expect(query('.reload-track i').style.transform).toBe('scaleX(0.4)');
  });

  it('raises a vignette as health falls', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(query('.hud-vignette').className).toContain('vignette-nominal');

    render(<Hud snapshot={snapshotFixture({ health: 18 })} />);
    expect(query('.hud-vignette').className).toContain('vignette-critical');
  });
});

describe('gameplay overlay states', () => {
  const level = cookLevel(defaultLevel);
  const baseProps = {
    error: null,
    level,
    settings: settingsFixture,
    save: saveFixture(),
    onSaveChange: () => {},
    onSettingsChange: () => {},
    onEnter: () => {},
    onExit: () => {},
  } as const;

  it('shows the full keyboard guidance on standby, including the grapple binding', () => {
    render(<GameOverlay {...baseProps} screenState="standby" snapshot={snapshotFixture()} />);
    const guide = query('.control-guide').textContent ?? '';
    for (const binding of ['WASD MOVE', 'SPACE JUMP', 'SPACE ×2 DASH', 'F HOOK', 'Q PULL', 'C SLIDE', 'E MELEE', 'R RELOAD']) {
      expect(guide).toContain(binding);
    }
    expect(query('.enter-action').textContent).toContain('Enter run');
  });

  it('presents completion telemetry rather than the standby guidance', () => {
    render(<GameOverlay {...baseProps} screenState="complete" snapshot={snapshotFixture({ health: 64, score: 1830 }, { completed: true, elapsedSeconds: 126.25 })} />);
    expect(query('#game-overlay-title').textContent).toBe('Run complete');
    expect(query('.completion-summary').textContent).toBe('2:06.25 · 1830 points');
    const grid = query('.completion-grid').textContent ?? '';
    expect(grid).toContain('2:06.25');
    expect(grid).toContain('1,830');
    expect(grid).toContain('White Line');
    expect(grid).toContain('64%');
    expect(container.querySelector('.control-guide')).toBeNull();
  });

  it('grades the finished run and compares it with the standing best', () => {
    const result = {
      save: saveFixture(),
      run: { timeSeconds: 126.25, score: 1830, rank: 'A' as const, deaths: 1, peakCombo: 11, splits: [] },
      previousBest: { timeSeconds: 140, score: 1600, rank: 'B' as const, deaths: 3, peakCombo: 5, splits: [] },
      isBestRun: true,
      isFastest: true,
    };
    render(<GameOverlay
      {...baseProps}
      screenState="complete"
      snapshot={snapshotFixture({ health: 64, score: 1830, deaths: 1 }, { completed: true, elapsedSeconds: 126.25 })}
      result={result}
    />);
    expect(query('.grade-letter').textContent).toBe('A');
    expect(query('.run-grade').className).toContain('grade-A');
    expect(query('.grade-copy .micro-label').textContent).toBe('NEW BEST RUN');
    const delta = query('.grade-delta').textContent ?? '';
    // Signed both ways: more points is better, less time is better.
    expect(delta).toContain('+230 pts');
    expect(delta).toContain('-13.75s');
    expect(query('.grade-flag').textContent).toBe('FASTEST');
    expect(query('.completion-grid').textContent).toContain('Deaths');
  });

  it('calls a first clear out rather than inventing a comparison', () => {
    const result = {
      save: saveFixture(),
      run: { timeSeconds: 200, score: 900, rank: 'C' as const, deaths: 5, peakCombo: 0, splits: [] },
      previousBest: null,
      isBestRun: true,
      isFastest: true,
    };
    render(<GameOverlay {...baseProps} screenState="complete" snapshot={snapshotFixture({ score: 900 }, { completed: true, elapsedSeconds: 200 })} result={result} />);
    expect(query('.grade-letter').textContent).toBe('C');
    expect(query('.grade-delta').textContent).toContain('First clear');
  });

  it('lists split deltas against the best run', () => {
    const result = {
      save: saveFixture(),
      run: { timeSeconds: 126.25, score: 1830, rank: 'A' as const, deaths: 0, peakCombo: 9, splits: [] },
      previousBest: {
        timeSeconds: 140,
        score: 1600,
        rank: 'B' as const,
        deaths: 0,
        peakCombo: 6,
        splits: [{ encounterId: 'arena-1', label: 'Atrium', seconds: 34 }],
      },
      isBestRun: true,
      isFastest: false,
    };
    render(<GameOverlay
      {...baseProps}
      screenState="complete"
      result={result}
      snapshot={snapshotFixture({}, {
        completed: true,
        elapsedSeconds: 126.25,
        splits: [
          { encounterId: 'arena-1', label: 'Atrium', seconds: 30.5 },
          { encounterId: 'arena-2', label: 'Gallery', seconds: 71.25 },
        ],
      })}
    />);
    const rows = [...container.querySelectorAll('.split-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.split-delta')?.textContent).toBe('-3.50s');
    expect(rows[0].querySelector('.split-delta')?.className).toContain('is-better');
    // No reference split for Gallery, so there is nothing honest to compare against.
    expect(rows[1].querySelector('.split-delta')?.textContent).toBe('—');
  });

  it('keeps a recoverable exit on the fault state', () => {
    const onExit = vi.fn();
    render(<GameOverlay {...baseProps} error="WebGL is unavailable." screenState="fault" snapshot={undefined} onExit={onExit} />);
    expect(query('.fault-copy .error-text').textContent).toBe('WebGL is unavailable.');
    act(() => query('.overlay-actions button').click());
    expect(onExit).toHaveBeenCalledOnce();
  });
});

describe('settings panel accessibility controls', () => {
  it('toggles reduced motion through the labelled checkbox', () => {
    const onChange = vi.fn();
    render(<SettingsPanel settings={settingsFixture} onChange={onChange} />);
    const toggle = query('input[aria-label="Reduced motion"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith({ reducedMotion: true });
  });

  it('applies the reduced-motion preset to every decorative camera setting', () => {
    const onChange = vi.fn();
    render(<SettingsPanel settings={settingsFixture} onChange={onChange} />);
    const preset = [...container.querySelectorAll('button')].find((button) => /reduced motion preset/i.test(button.textContent ?? ''));
    act(() => preset?.click());
    expect(onChange).toHaveBeenCalledWith({ headBob: 0, cameraRoll: 0, shake: 0, reducedMotion: true });
  });

  it('marks the enabled state on the toggle row when reduced motion is on', () => {
    render(<SettingsPanel settings={{ ...settingsFixture, reducedMotion: true }} onChange={() => {}} />);
    const rows = [...container.querySelectorAll('.toggle-row')];
    const reducedMotionRow = rows.find((row) => row.textContent?.startsWith('Reduced motion'));
    expect(reducedMotionRow?.className).toContain('is-enabled');
  });
});

describe('save migration', () => {
  it('defaults reduced motion from the media query when a legacy save omits it', () => {
    // jsdom omits matchMedia entirely, so the preference has to be stubbed in.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion') }));
    try {
      const migrated = migrateSaveData({ schemaVersion: 1, settings: { fov: 100 }, bestTimeSeconds: null, bestScore: 0, rank: null });
      expect(migrated.schemaVersion).toBe(4);
      expect(migrated.settings.reducedMotion).toBe(true);
      expect(migrated.settings.fov).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves an explicit reduced-motion choice over the media query default', () => {
    const migrated = migrateSaveData({ schemaVersion: 1, settings: { reducedMotion: false }, bestTimeSeconds: 42, bestScore: 700, rank: 'A' });
    expect(migrated.settings.reducedMotion).toBe(false);
    expect(migrated.settings.graphicsQuality).toBe('auto');
    expect(migrated.bestTimeSeconds).toBe(42);
  });
});

describe('interface primitives', () => {
  it('exposes sections as native keyboard-operable disclosures', () => {
    render(<Section title="Build" meta="clean" defaultOpen={false}><p>body</p></Section>);
    const details = query('details.ui-section') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(query('summary').textContent).toContain('Build');
    act(() => query('summary').click());
    expect(details.open).toBe(true);
  });

  it('marks the active tab for assistive technology', () => {
    const onChange = vi.fn();
    render(<Tabs label="Hierarchy filter" value="all" options={[{ id: 'all', label: 'All' }, { id: 'lights', label: 'Lights' }]} onChange={onChange} />);
    const [all, lights] = [...container.querySelectorAll('[role="tab"]')];
    expect(all.getAttribute('aria-selected')).toBe('true');
    expect(lights.getAttribute('aria-selected')).toBe('false');
    act(() => (lights as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith('lights');
  });

  it('describes the focusable tooltip target instead of relying on hover-only text', () => {
    render(<Tooltip hint="Step backward"><button>Undo</button></Tooltip>);
    const button = query('button');
    expect(query('[role="tooltip"]').id).toBe(button.getAttribute('aria-describedby'));
    expect(query('[role="tooltip"]').textContent).toBe('Step backward');
  });
});

describe('weapon builder', () => {
  function open(overrides: Partial<SaveDataV4> = {}) {
    const save = { ...saveFixture(), ...overrides };
    const onChange = vi.fn();
    render(<WeaponBuilder save={save} onChange={onChange} onClose={() => {}} />);
    return { save, onChange };
  }

  it('lists the armory and shows the selected build', () => {
    const { save } = open();
    const list = query('[aria-label="Saved builds"]');
    expect(list.textContent).toContain(save.armory[0].name);
    expect(list.textContent).toContain(save.armory[1].name);
    expect(query('.builder-header h2').textContent).toBe(save.armory[0].name);
  });

  it('fits a part and reports the change through onChange', () => {
    const { onChange } = open();
    setFieldValue(query('select[aria-label="Magazine"]') as HTMLSelectElement, 'magazine.drum');
    const next = onChange.mock.calls.at(-1)![0] as SaveDataV4;
    expect(next.armory[0].parts.magazine).toBe('magazine.drum');
    // The drum should genuinely raise capacity once resolved.
    expect(resolveWeaponStats(next.armory[0]).magazineSize).toBeGreaterThan(resolveWeaponStats(saveFixture().armory[0]).magazineSize);
  });

  it('clears fitted parts when the chassis changes, since slots differ', () => {
    const { onChange } = open();
    const shotgunTab = [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Shotgun');
    act(() => (shotgunTab as HTMLButtonElement).click());
    const next = onChange.mock.calls.at(-1)![0] as SaveDataV4;
    expect(next.armory[0].chassisId).toBe('shotgun');
    expect(next.armory[0].parts).toEqual({});
  });

  it('renames a build', () => {
    const { onChange } = open();
    setFieldValue(query('input[aria-label="Build name"]') as HTMLInputElement, 'Breacher');
    expect((onChange.mock.calls.at(-1)![0] as SaveDataV4).armory[0].name).toBe('Breacher');
  });

  it('assigns the selected build to a loadout slot', () => {
    const { save, onChange } = open();
    const carryTwo = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Carry as 2');
    act(() => carryTwo?.click());
    expect((onChange.mock.calls.at(-1)![0] as SaveDataV4).loadout).toEqual([save.armory[0].id, save.armory[0].id]);
  });

  it('adds a build and refuses to empty the armory', () => {
    const { onChange } = open();
    const add = [...container.querySelectorAll('button')].find((button) => button.textContent === 'New build');
    act(() => add?.click());
    expect((onChange.mock.calls.at(-1)![0] as SaveDataV4).armory).toHaveLength(3);

    const single = saveFixture();
    const only = { ...single, armory: [single.armory[0]], loadout: [single.armory[0].id, single.armory[0].id] as const };
    const onChangeSingle = vi.fn();
    render(<WeaponBuilder save={only} onChange={onChangeSingle} onClose={() => {}} />);
    const remove = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
  });

  it('marks stats that improved or worsened against the chassis base', () => {
    const armory = [{ id: 'a', name: 'Long', chassisId: 'carbine' as const, parts: { barrel: 'barrel.long' } }];
    open({ armory, loadout: ['a', 'a'] });
    const rows = [...container.querySelectorAll('.stat-readout > div')];
    const rangeRow = rows.find((row) => row.querySelector('dt')?.textContent === 'Range');
    const hipRow = rows.find((row) => row.querySelector('dt')?.textContent === 'Hip spread');
    expect(rangeRow?.querySelector('.stat-delta')?.className).toContain('is-better');
    expect(hipRow?.querySelector('.stat-delta')?.className).toContain('is-worse');
  });

  it('warns that mid-run edits are deferred', () => {
    render(<WeaponBuilder save={saveFixture()} onChange={() => {}} onClose={() => {}} deferredNotice />);
    expect(query('.builder-notice').textContent).toContain('next checkpoint');
  });
});
