import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveDataV6, SaveSettingsV3, SimulationSnapshot } from '../src/contracts';
import { cookLevel, defaultLevel } from '../src/content/defaultLevel';
import { bladeStyles } from '../src/content/blades';
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

/**
 * The results screen counts its numbers up and settles on any key or click, so a
 * test that wants the final figures presses a key rather than waiting out the
 * sequence. This is the same escape the player gets.
 */
function skipSequence(): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
}

function query(selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Expected the DOM to contain "${selector}".`);
  return element;
}

/**
 * The loadout as the snapshot publishes it. `inHand` defaults to the gun here because
 * most of these cases are about the ammo corner, and the blade cases say so explicitly --
 * which is the point of the field existing: what is in the player's hands is a fact the
 * simulation states rather than something the HUD infers.
 */
function weaponsFixture(inHand: 'blade' | 'gun'): SimulationSnapshot['player']['weapons'] {
  return {
    activeSlot: 0,
    ready: true,
    inHand,
    blade: 'tempo',
    slots: [
      { name: 'Carbine', chassisId: 'carbine' as const, parts: {}, ammo: 30, reserveAmmo: 120 },
      { name: 'SMG', chassisId: 'smg' as const, parts: {}, ammo: 40, reserveAmmo: 180 },
    ],
  };
}

function snapshotFixture(overrides: Partial<SimulationSnapshot['player']> = {}, snapshot: Partial<SimulationSnapshot> = {}): SimulationSnapshot {
  return {
    tick: 120,
    elapsedSeconds: 73.5,
    entities: [{ id: 1, kind: 'player', position: [0, 1, 0], velocity: [0, 0, 0], rotationY: 0, grounded: true, aimPitch: 0, health: 100, maxHealth: 100 }],
    camera: { position: [0, 1.58, 0], yaw: 0, pitch: 0, fov: 92 },
    player: {
      health: 100,
      ammo: 24,
      reserveAmmo: 119,
      magazineSize: 30,
      weapons: weaponsFixture('gun'),
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
      dodge: { invulnerable: false, ready: true, cooldown: 0 },
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
    wave: { current: 0, total: 0 },
    completed: false,
    openGateIds: [],
    ...snapshot,
  };
}

function saveFixture(): SaveDataV6 {
  const armory = defaultArmory();
  return {
    schemaVersion: 6,
    settings: settingsFixture,
    bestRun: null,
    bestTimeSeconds: null,
    armory,
    loadout: [armory[0].id, armory[1].id],
    blade: 'tempo',
  };
}

const settingsFixture: SaveSettingsV3 = {
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
  volume: 0.8,
};

describe('HUD grapple presentation', () => {
  it('reports the armed state and a full readiness meter when the hook is available', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(query('.grapple-readout').getAttribute('aria-label')).toBe('Grapple armed');
    expect(query('.grapple-readout').className).toContain('grapple-ready');
    expect(query('.crosshair').className).toContain('hook-ready');
    expect(query('.grapple-readout > i').style.transform).toBe('scaleX(1)');
    expect(query('.grapple-readout strong').textContent).toBe('HOOK');
  });

  it('reports rope length and a tethered crosshair while attached', () => {
    render(<Hud snapshot={snapshotFixture({
      locomotion: 'grappling',
      grapple: { active: true, anchor: [0, 14, -69], ropeLength: 18.42, cooldown: 0, available: false, aim: null },
    })} />);
    expect(query('.grapple-readout').getAttribute('aria-label')).toBe('Grapple tethered');
    expect(query('.grapple-readout strong').textContent).toBe('PULL 18M');
    expect(query('.crosshair').className).toContain('locked');
    expect(query('.hud').className).toContain('is-grappling');
  });

  it('drains the cooldown meter proportionally while relinking', () => {
    render(<Hud snapshot={snapshotFixture({
      grapple: { active: false, anchor: null, ropeLength: 0, cooldown: 0.175, available: false, aim: null },
    })} />);
    expect(query('.grapple-readout').getAttribute('aria-label')).toBe('Grapple relink');
    expect(query('.grapple-readout > i').style.transform).toBe('scaleX(0.5)');
    expect(query('.grapple-readout strong').textContent).toBe('0.2');
    expect(query('.crosshair').className).toContain('cooldown');
  });

  it('keeps the reticle cluster to the readouts a player acts on mid-air', () => {
    render(<Hud snapshot={snapshotFixture()} ghost={{ deltaSeconds: -0.5, finished: false }} ovation={{ id: 3, links: 6 }} />);
    const cluster = query('.flow-cluster');
    // Hook state, chain and the ghost delta — and specifically not the five-chip
    // chain rail that reported availability the multiplier already implies.
    expect(cluster.querySelector('.grapple-readout')).not.toBeNull();
    expect(cluster.querySelector('.combo-readout')).not.toBeNull();
    expect(cluster.querySelector('.ghost-delta')).not.toBeNull();
    expect(container.querySelector('.chain-rail')).toBeNull();
    expect(container.querySelectorAll('.chain-step')).toHaveLength(0);
    // The chain flourish is a frame layer, not a fifth thing in the cluster. It is
    // masked hollow around the centre in CSS; what the DOM has to guarantee is that
    // it never becomes part of the set the player reads off the crosshair.
    expect(cluster.querySelector('.chain-ovation')).toBeNull();
    expect(query('.chain-ovation').parentElement?.className).toContain('hud');
  });

  it('drops the modules that said the same number twice', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    // Health kept its value and lost the twelve-segment meter; ammo kept its value
    // and lost the pip track and the weapon strip; speed lost both of its readouts.
    expect(query('.health-value strong').textContent).toBe('100');
    expect(container.querySelector('.ui-meter')).toBeNull();
    expect(query('.ammo-value strong').textContent).toBe('24');
    expect(container.querySelector('.ammo-track')).toBeNull();
    expect(container.querySelector('.hud .weapon-strip')).toBeNull();
    expect(container.querySelector('.speed-readout')).toBeNull();
    expect(container.querySelector('.speed-spectrum')).toBeNull();
    expect(container.querySelector('.hud-telemetry')).toBeNull();
  });

  it('carries the objective, the hostiles left and the run clock on one top bar', () => {
    render(<Hud snapshot={snapshotFixture({}, {
      objective: 'Clear: Gallery',
      entities: [
        { id: 1, kind: 'player', position: [0, 1, 0], velocity: [0, 0, 0], rotationY: 0, grounded: true, aimPitch: 0, health: 100, maxHealth: 100 },
        { id: 2, kind: 'bot', position: [4, 1, -8], velocity: [0, 0, 0], rotationY: 0, grounded: true, aimPitch: 0, health: 40, maxHealth: 100 },
        { id: 3, kind: 'bot', position: [6, 1, -9], velocity: [0, 0, 0], rotationY: 0, grounded: true, aimPitch: 0, health: 0, maxHealth: 100 },
      ],
    })} />);
    const bar = query('.hud-objective');
    expect(bar.textContent).toContain('Clear: Gallery');
    expect(query('.objective-count').textContent).toBe('01');
    expect(query('.objective-count').getAttribute('aria-label')).toBe('1 hostile remaining');
    expect(query('.objective-clock').textContent).toBe('1:13.50');
  });

  it('names the live wave on the top bar, and only in a room that has more than one', () => {
    render(<Hud snapshot={snapshotFixture({}, { wave: { current: 2, total: 3 } })} />);
    const chip = query('.objective-wave');
    expect(chip.textContent).toBe('W2/3');
    expect(chip.getAttribute('aria-label')).toBe('Wave 2 of 3');
    // It belongs to the objective it qualifies, not to the reticle cluster.
    expect(chip.closest('.hud-objective')).not.toBeNull();

    // A room without waves, and between rooms, says nothing at all.
    render(<Hud snapshot={snapshotFixture({}, { wave: { current: 1, total: 1 } })} />);
    expect(container.querySelector('.objective-wave')).toBeNull();
    render(<Hud snapshot={snapshotFixture({}, { wave: { current: 0, total: 0 } })} />);
    expect(container.querySelector('.objective-wave')).toBeNull();
  });

  it('names the contract for the day on the top bar', () => {
    render(<Hud snapshot={snapshotFixture()} modifier={{
      id: 'glass', label: 'Glass cannon', description: 'Everything hits harder.',
      favouredChassis: [], chassisBonus: 0.2, linkBonus: 0.1, enemy: {},
    }} />);
    expect(query('.objective-modifier').textContent).toContain('GLASS CANNON');
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

  it('escalates the vitals corner when health drops into the critical band', () => {
    render(<Hud snapshot={snapshotFixture({ health: 18 })} />);
    expect(query('.hud').className).toContain('health-critical');
    expect(query('.health-value').getAttribute('aria-label')).toBe('Health 18 of 100');
    expect(query('.hud-health .corner-flag').textContent).toBe('CRITICAL');
  });
});

describe('the graphic layer in the play frame', () => {
  it('turns the frame into a panel on the three moments that earn it', () => {
    render(<Hud snapshot={snapshotFixture()} moment={{ id: 9, kind: 'wave', label: 'WAVE 2' }} />);
    const panel = container.querySelector('.graphic-moment');
    expect(panel).not.toBeNull();
    expect(panel?.classList.contains('moment-wave')).toBe(true);
    expect(container.querySelector('.moment-label')?.textContent).toBe('WAVE 2');
    // Decorative in the strict sense: it is not in the accessibility tree at all, the
    // way the chain flourish and the dodge mark are not.
    expect(panel?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws nothing at all the rest of the time', () => {
    // The count is the design. A graphic transition every few minutes is a signature;
    // one every thirty seconds is a tic.
    render(<Hud snapshot={snapshotFixture()} />);
    expect(container.querySelector('.graphic-moment')).toBeNull();
  });
});

describe('hit feedback', () => {
  const hit = (overrides: Partial<{ id: number; screen: readonly [number, number]; amount: number; headshot: boolean; kill: boolean; deflected: boolean }> = {}) => ({
    id: 1, screen: [400, 300] as const, amount: 34, headshot: false, kill: false, deflected: false, ...overrides,
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

  it('states the death count where the player is stopped rather than mid-flight', () => {
    // The live counter left the HUD in the reduction; the down panel still charges
    // the death, and the pause screen keeps the running total.
    render(<Hud snapshot={snapshotFixture({ deaths: 3 })} />);
    expect(container.querySelector('.run-deaths')).toBeNull();
    render(<Hud snapshot={snapshotFixture({ awaitingRespawn: true, deaths: 3, health: 0 })} />);
    expect(query('.down-cost').textContent).toContain('Death 3');
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
    expect(query('.combo-readout').className).toContain('combo-live');
    expect(query('.combo-window').style.transform).toBe('scaleX(0.8)');

    render(<Hud snapshot={snapshotFixture({ combo: { links: 4, multiplier: 1.4, window: 0.2, peakLinks: 6 } })} />);
    expect(query('.combo-readout').className).toContain('combo-lapsing');
  });

  it('says nothing but the multiplier while no chain is running', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(query('.combo-readout').className).toContain('combo-idle');
    expect(query('.combo-multiplier').textContent).toBe('×1.0');
    expect(container.querySelector('.combo-links')).toBeNull();
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

  it('marks a hit a shield arc absorbed', () => {
    render(<Hud snapshot={snapshotFixture()} hits={[hit({ id: 9, amount: 6, deflected: true })]} />);
    expect(query('.hitmarker').className).toContain('is-deflected');
    expect(query('.damage-number').className).toContain('is-deflected');
    // A kill still reads as a kill, whatever ate the rounds before it.
    render(<Hud snapshot={snapshotFixture()} hits={[hit({ id: 10, deflected: true, kill: true })]} />);
    expect(query('.hitmarker').className).toContain('is-kill');
    expect(query('.damage-number').className).not.toContain('is-deflected');
  });

  it('draws the chain flourish only while the runtime is publishing one', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    // Nothing persistent: with no ovation in flight there is no element at all.
    expect(container.querySelector('.chain-ovation')).toBeNull();

    render(<Hud snapshot={snapshotFixture()} ovation={{ id: 12, links: 10 }} />);
    const flourish = query('.chain-ovation');
    expect(flourish.getAttribute('aria-hidden')).toBe('true');
    expect(query('.ovation-mark b').textContent).toBe('10');
  });

  it('marks a kill on the confirm and the number rather than adding a module for it', () => {
    render(<Hud snapshot={snapshotFixture()} hits={[hit({ id: 21, amount: 34 })]} />);
    const plain = container.querySelectorAll('.hud > *').length;

    render(<Hud snapshot={snapshotFixture()} hits={[hit({ id: 21, kill: true, amount: 34 })]} />);
    expect(query('.hitmarker').className).toContain('is-kill');
    expect(query('.damage-number').className).toContain('is-kill');
    // The burst is a restyle of two elements that were already inside the reticle
    // budget, so a kill adds no node to the play frame at all.
    expect(container.querySelectorAll('.hud > *')).toHaveLength(plain);
  });

  it('confirms a perfect dodge in a corner, clear of the crosshair and of the flourish', () => {
    render(<Hud
      snapshot={snapshotFixture()}
      dodge={{ id: 9, refused: 15 }}
      ovation={{ id: 3, links: 6 }}
    />);
    const mark = query('.perfect-dodge');
    expect(mark.textContent).toContain('PERFECT');
    // The number a player wants from a dodge is the one that did not happen.
    expect(query('.perfect-dodge i').textContent).toBe('15');
    // A dodge pays a chain link, so a dodge and a flourish can land on the same frame.
    // They sit on opposite sides for exactly that reason.
    expect(mark.parentElement?.className).toContain('hud');
    expect(query('.chain-ovation')).not.toBeNull();
    // And neither of them joins the set read off the crosshair.
    expect(query('.flow-cluster').querySelector('.perfect-dodge')).toBeNull();
  });

  it('says nothing about a dodge that has not happened', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(container.querySelector('.perfect-dodge')).toBeNull();
    expect(query('.crosshair').className).not.toContain('dodge-live');
  });

  it('marks the invulnerable window on the reticle rather than beside it', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    const plain = container.querySelectorAll('.hud > *').length;

    render(<Hud snapshot={snapshotFixture({ dodge: { invulnerable: true, ready: false, cooldown: 0.4 } })} />);
    expect(query('.crosshair').className).toContain('dodge-live');
    // A 0.22 s state on an element that was already there. It adds no node to the
    // play frame, which is the rule the kill burst was built to.
    expect(container.querySelectorAll('.hud > *')).toHaveLength(plain);
  });

  it('renders one number per hit in a batch', () => {
    render(<Hud snapshot={snapshotFixture()} hits={[hit({ id: 1 }), hit({ id: 2, amount: 59 }), hit({ id: 3, amount: 12 })]} />);
    expect([...container.querySelectorAll('.damage-number')].map((node) => node.textContent)).toEqual(['34', '59', '12']);
    // Only the newest hit drives the crosshair marker.
    expect(container.querySelectorAll('.hitmarker')).toHaveLength(1);
  });
});

describe('the health corner says what a kill paid back', () => {
  it('shows the amount returned, in the corner it belongs to', () => {
    render(<Hud snapshot={snapshotFixture({ health: 96 })} heal={{ id: 4, amount: 14 }} />);
    // Inside the readout rather than beside it: the play frame is six readouts in four
    // zones and lifesteal is not a seventh.
    expect(query('.hud-health .heal-mark').textContent).toBe('+14');
    expect(query('.hud-health .heal-mark').getAttribute('aria-label')).toBe('14 health returned');
    expect(query('.hud-health').className).toContain('is-healing');
    expect(query('.health-value strong').textContent).toBe('96');
  });

  it('says nothing at all when no kill has paid one', () => {
    render(<Hud snapshot={snapshotFixture()} />);
    expect(container.querySelector('.heal-mark')).toBeNull();
    expect(query('.hud-health').className).not.toContain('is-healing');
  });
});

describe('the ammo corner says what is in hand', () => {
  it('names the blade and offers no magazine while the blade is up', () => {
    render(<Hud snapshot={snapshotFixture({ weapons: weaponsFixture('blade') })} />);
    // The bug this replaces: the corner read `CARBINE 30/120` while a blade was on
    // screen and in the player's hands, because it named the active gun unconditionally.
    expect(query('.ammo-weapon span').textContent).toBe('Tempo');
    expect(query('.ammo-value').getAttribute('aria-label')).toBe('Tempo blade in hand, no ammunition');
    expect(query('.ammo-value').textContent).not.toContain('24');
    expect(query('.hud-ammo').className).toContain('holding-blade');
  });

  it('names the style the run is actually carrying', () => {
    render(<Hud snapshot={snapshotFixture({ weapons: { ...weaponsFixture('blade'), blade: 'riposte' } })} />);
    expect(query('.ammo-weapon span').textContent).toBe('Riposte');
  });

  it('keeps the gun magazine and the capacity its label announces', () => {
    render(<Hud snapshot={snapshotFixture({ weapons: weaponsFixture('gun') })} />);
    // Accessibility work that has survived two HUD passes, and the fix for the label
    // above must not be a way of deleting it.
    expect(query('.ammo-weapon span').textContent).toBe('Carbine');
    expect(query('.ammo-value').getAttribute('aria-label')).toBe('24 of 30 rounds in magazine');
    expect(query('.ammo-value').textContent).toBe('24/ 119');
  });

  it('does not warn about a magazine that is not in the player\'s hands', () => {
    render(<Hud snapshot={snapshotFixture({ ammo: 0, weapons: weaponsFixture('blade') })} />);
    // An empty gun in a holster is not an emergency. The corner flag, the red border
    // and the root class all belong to the weapon the player is holding.
    expect(query('.hud').className).toContain('ammo-nominal');
    expect(container.querySelector('.hud-ammo .corner-flag')).toBeNull();
  });

  it('still draws the reload track, which is the one thing the gun has to be seen doing', () => {
    render(<Hud snapshot={snapshotFixture({ action: 'reloading', actionProgress: 0.5, weapons: weaponsFixture('gun') })} />);
    expect(query('.reload-track')).toBeTruthy();
  });
});

describe('health and ammo emphasis', () => {
  it('flags a low magazine and still announces the real capacity', () => {
    render(<Hud snapshot={snapshotFixture({ ammo: 4, magazineSize: 30 })} />);
    expect(query('.hud').className).toContain('ammo-low');
    expect(query('.hud-ammo .corner-flag').textContent).toBe('LOW');
    expect(query('.ammo-value').getAttribute('aria-label')).toBe('4 of 30 rounds in magazine');
    expect(query('.ammo-value').textContent).toBe('4/ 119');
  });

  it('flags an empty magazine and names the live weapon', () => {
    render(<Hud snapshot={snapshotFixture({ ammo: 0 })} />);
    expect(query('.hud').className).toContain('ammo-empty');
    expect(query('.hud-ammo .corner-flag').textContent).toBe('EMPTY');
    expect(query('.ammo-weapon span').textContent).toBe('Carbine');
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

  it('shows the full guidance on standby, leading with the one trigger', () => {
    render(<GameOverlay {...baseProps} screenState="standby" snapshot={snapshotFixture()} />);
    const guide = query('.control-guide').textContent ?? '';
    // One attack verb on the mouse and a selector on the numbers. The guide names the
    // trigger first, because it is the only button whose meaning the player chooses.
    for (const binding of ['LMB ATTACK', 'E HEAVY', 'RMB AIM', 'WASD MOVE', 'SPACE JUMP', 'SPACE ×2 DASH / DODGE', 'F HOOK', 'Q PULL', 'C SLIDE', '1 2 3 BLADE / GUNS', 'R RELOAD']) {
      expect(guide).toContain(binding);
    }
    expect(guide.indexOf('LMB ATTACK')).toBeLessThan(guide.indexOf('RMB AIM'));
    // And nothing anywhere says the mouse fires or slashes, which is the confusion the
    // scheme was rebuilt to remove.
    expect(guide).not.toContain('E MELEE');
    expect(guide).not.toContain('LMB FIRE');
    expect(guide).not.toContain('LMB SLASH');
    expect(guide).not.toContain('SIDEARM');
    expect(query('.enter-action').textContent).toContain('Enter run');
  });

  it('keeps the telemetry the HUD stopped drawing on the pause screen', () => {
    render(<GameOverlay {...baseProps} screenState="standby" snapshot={snapshotFixture({ score: 1830, deaths: 2, health: 44, combo: { links: 0, multiplier: 1, window: 0, peakLinks: 7 } }, {
      elapsedSeconds: 126.25,
      entities: [
        { id: 1, kind: 'player', position: [0, 1, 0], velocity: [0, 0, 0], rotationY: 0, grounded: true, aimPitch: 0, health: 44, maxHealth: 100 },
        { id: 2, kind: 'bot', position: [4, 1, -8], velocity: [0, 0, 0], rotationY: 0, grounded: true, aimPitch: 0, health: 40, maxHealth: 100 },
      ],
      splits: [{ encounterId: 'arena-1', label: 'Atrium', seconds: 30.5 }],
    })} />);
    const status = query('.run-status').textContent ?? '';
    expect(status).toContain('2:06.25');
    expect(status).toContain('1,830');
    expect(status).toContain('DEATHS');
    expect(status).toContain('01');
    expect(status).toContain('PEAK CHAIN');
    // The twelve-segment vitals meter and the weapon strip live here now.
    expect(query('.run-status .ui-meter').getAttribute('aria-label')).toBe('HP: 44 of 100');
    expect(query('.run-status .weapon-strip').getAttribute('aria-label')).toBe('Carried weapons');
    // Splits so far, with nothing to compare them against mid-run.
    expect(query('.run-status .split-row .split-time').textContent).toBe('0:30.50');
    expect(query('.run-status .split-row .split-delta').textContent).toBe('—');
  });

  it('presents completion telemetry rather than the standby guidance', () => {
    render(<GameOverlay {...baseProps} screenState="complete" snapshot={snapshotFixture({ health: 64, score: 1830 }, { completed: true, elapsedSeconds: 126.25 })} />);
    expect(query('#game-overlay-title').textContent).toBe('Run complete');
    skipSequence();
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

  it('runs the results as a skippable sequence rather than a grid that appears at once', () => {
    render(<GameOverlay
      {...baseProps}
      screenState="complete"
      snapshot={snapshotFixture({ health: 64, score: 1830 }, { completed: true, elapsedSeconds: 126.25 })}
      result={{
        save: saveFixture(),
        run: { timeSeconds: 126.25, score: 1830, rank: 'A' as const, deaths: 0, peakCombo: 9, splits: [] },
        previousBest: null,
        isBestRun: true,
        isFastest: true,
      }}
    />);
    // Before anything is skipped the screen is mid-sequence and the headline
    // numbers are still on their way up, not printed.
    expect(query('.completion-state').className).toContain('is-sequencing');
    expect(query('.completion-summary').textContent).not.toContain('1830');
    // Every revealed line carries the stagger index CSS animates off.
    const steps = [...container.querySelectorAll<HTMLElement>('.completion-state .reveal-line')];
    expect(steps.length).toBeGreaterThan(4);
    expect(steps.every((line) => line.style.getPropertyValue('--step') !== '')).toBe(true);
    // The rank slams and the clear stamps; both are their own motion, not a line.
    expect(query('.grade-letter').className).toContain('reveal-slam');
    expect(query('.completion-stamp').className).toContain('reveal-stamp');

    skipSequence();
    expect(query('.completion-state').className).toContain('is-settled');
    // Skipping lands the real values, not an eased approximation of them.
    expect(query('.completion-summary').textContent).toBe('2:06.25 · 1830 points');
    expect(query('.completion-grid').textContent).toContain('64%');
  });

  it('presents the results settled from the first frame under reduced motion', () => {
    render(<GameOverlay
      {...baseProps}
      settings={{ ...settingsFixture, reducedMotion: true }}
      screenState="complete"
      snapshot={snapshotFixture({ health: 64, score: 1830 }, { completed: true, elapsedSeconds: 126.25 })}
    />);
    expect(query('.completion-state').className).toContain('is-settled');
    expect(query('.completion-summary').textContent).toBe('2:06.25 · 1830 points');
  });

  it('leaves the pause screen splits unsequenced, since nothing is revealing there', () => {
    render(<GameOverlay {...baseProps} screenState="standby" snapshot={snapshotFixture({}, {
      splits: [{ encounterId: 'arena-1', label: 'Atrium', seconds: 30.5 }],
    })} />);
    expect(query('.run-status .split-row').className).not.toContain('reveal-line');
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

  it('gives the mix a level, and says so when it is muted', () => {
    const onChange = vi.fn();
    render(<SettingsPanel settings={settingsFixture} onChange={onChange} />);
    const slider = query('input[aria-label="Volume"]') as HTMLInputElement;
    // The mix holds a floor under every room, so this is the row that lets a player
    // live with it. It has a labelled control, and zero reads as a state rather than
    // as a number.
    expect(slider.value).toBe('0.8');
    expect(query('.setting-control').textContent).toContain('80%');
    render(<SettingsPanel settings={{ ...settingsFixture, volume: 0 }} onChange={onChange} />);
    expect(query('.setting-control').textContent).toContain('MUTE');
  });

  it('marks the enabled state on the toggle row when reduced motion is on', () => {
    render(<SettingsPanel settings={{ ...settingsFixture, reducedMotion: true }} onChange={() => {}} />);
    const rows = [...container.querySelectorAll('.toggle-row')];
    const reducedMotionRow = rows.find((row) => row.textContent?.startsWith('Reduced motion'));
    expect(reducedMotionRow?.className).toContain('is-enabled');
  });
});

describe('the bench chooses a blade', () => {
  it('leads with the blade, and each card is read for what it does to the chain', () => {
    let latest = saveFixture();
    render(<WeaponBuilder save={latest} onChange={(next) => { latest = next; }} onClose={() => {}} />);

    const cards = [...container.querySelectorAll('.blade-style')];
    expect(cards).toHaveLength(bladeStyles.length);
    // The last line of a card is the chain note, and that is the choice being made: a
    // card that only reported damage would put the blade back in the gun's stat game.
    for (const card of cards) {
      const note = card.querySelector('em');
      expect(note?.textContent ?? '').not.toBe('');
    }
    // The blade section comes before the gun loadout, because it is the primary verb.
    const body = query('.builder-armory').textContent ?? '';
    expect(body.indexOf('Tempo')).toBeLessThan(body.indexOf('sidearms'));
  });

  it('reports and changes which style is carried', () => {
    let latest = saveFixture();
    const rerender = () => render(<WeaponBuilder save={latest} onChange={(next) => { latest = next; }} onClose={() => {}} />);
    rerender();

    const selected = () => [...container.querySelectorAll('.blade-style')].find((card) => card.getAttribute('aria-checked') === 'true');
    expect(selected()?.textContent).toContain('Tempo');

    const cleave = [...container.querySelectorAll<HTMLElement>('.blade-style')].find((card) => card.textContent?.includes('Cleave'))!;
    act(() => cleave.click());
    expect(latest.blade).toBe('cleave');
    rerender();
    expect(selected()?.textContent).toContain('Cleave');
  });

  it('keeps the gun bench intact beside it', () => {
    // A repoint, not a rewrite: the chassis tabs, the slots and the stat rows are all
    // still there, because the sidearm is still a stat game.
    render(<WeaponBuilder save={saveFixture()} onChange={() => {}} onClose={() => {}} />);
    expect(container.querySelector('.blade-styles')).not.toBeNull();
    expect(container.querySelectorAll('[role="tab"]').length).toBeGreaterThanOrEqual(4);
    expect(query('.builder-bench')).not.toBeNull();
  });
});

describe('save migration', () => {
  it('defaults reduced motion from the media query when a legacy save omits it', () => {
    // jsdom omits matchMedia entirely, so the preference has to be stubbed in.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion') }));
    try {
      const migrated = migrateSaveData({ schemaVersion: 1, settings: { fov: 100 }, bestTimeSeconds: null, bestScore: 0, rank: null });
      expect(migrated.schemaVersion).toBe(6);
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
  function open(overrides: Partial<SaveDataV6> = {}) {
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

  /** Opens a slot on the bench and returns the cards that fit it. */
  function openSlot(slot: string): HTMLButtonElement[] {
    const tile = [...container.querySelectorAll<HTMLButtonElement>('.slot-tile')]
      .find((candidate) => candidate.querySelector('.slot-name')?.textContent === slot);
    act(() => tile!.click());
    return [...container.querySelectorAll<HTMLButtonElement>('.part-card')];
  }

  it('fits a part from the bench and reports the change through onChange', () => {
    const { onChange } = open();
    const drum = openSlot('Magazine').find((card) => card.textContent?.includes('Drum'));
    act(() => drum!.click());
    const next = onChange.mock.calls.at(-1)![0] as SaveDataV6;
    expect(next.armory[0].parts.magazine).toBe('magazine.drum');
    // The drum should genuinely raise capacity once resolved.
    expect(resolveWeaponStats(next.armory[0]).magazineSize).toBeGreaterThan(resolveWeaponStats(saveFixture().armory[0]).magazineSize);
  });

  it('marks the slot the fitted part sits in and the card that is in it', () => {
    const armory = [{ id: 'a', name: 'Long', chassisId: 'carbine' as const, parts: { barrel: 'barrel.long' } }];
    open({ armory, loadout: ['a', 'a'] });
    const barrelTile = [...container.querySelectorAll('.slot-tile')]
      .find((tile) => tile.querySelector('.slot-name')?.textContent === 'Barrel');
    expect(barrelTile?.className).toContain('is-fitted');
    expect(barrelTile?.textContent).toContain('Long barrel');

    const fitted = openSlot('Barrel').find((card) => card.getAttribute('aria-pressed') === 'true');
    expect(fitted?.textContent).toContain('Long barrel');
  });

  it('states what each part would cost before it is fitted', () => {
    open();
    const long = openSlot('Barrel').find((card) => card.textContent?.includes('Long barrel'))!;
    const effects = [...long.querySelectorAll('.part-effect')].map((effect) => effect.textContent ?? '');
    // Reach is the reason to fit it and steadiness is the price, and both are named.
    expect(effects.join(' ')).toContain('Range +40%');
    expect(long.querySelector('.part-effect.is-better')?.textContent).toContain('Range');
    expect(effects.some((effect) => /Hip spread/.test(effect))).toBe(true);
    expect([...long.querySelectorAll('.part-effect.is-worse')].length).toBeGreaterThan(0);
  });

  it('previews a hovered part on the stat bars without committing it', () => {
    const { onChange } = open();
    const long = openSlot('Barrel').find((card) => card.textContent?.includes('Long barrel'))!;
    act(() => long.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const rangeRow = [...container.querySelectorAll('.stat-readout > div')]
      .find((row) => row.querySelector('dt')?.textContent === 'Range');
    expect(rangeRow?.querySelector('.stat-ghost')?.className).toContain('is-better');
    // Hovering is not fitting.
    expect(onChange).not.toHaveBeenCalled();

    act(() => long.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(container.querySelector('.stat-ghost')).toBeNull();
  });

  it('falls back to a plate when there is no 3D context to preview in', () => {
    open();
    // jsdom has no WebGL, which is the same path a browser that refuses a context takes.
    expect(query('.weapon-stage').className).toContain('is-unavailable');
    expect(query('.weapon-stage').getAttribute('aria-label')).toContain('unavailable');
  });

  it('clears fitted parts when the chassis changes, since slots differ', () => {
    const { onChange } = open();
    const shotgunTab = [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Shotgun');
    act(() => (shotgunTab as HTMLButtonElement).click());
    const next = onChange.mock.calls.at(-1)![0] as SaveDataV6;
    expect(next.armory[0].chassisId).toBe('shotgun');
    expect(next.armory[0].parts).toEqual({});
  });

  it('renames a build', () => {
    const { onChange } = open();
    setFieldValue(query('input[aria-label="Build name"]') as HTMLInputElement, 'Breacher');
    expect((onChange.mock.calls.at(-1)![0] as SaveDataV6).armory[0].name).toBe('Breacher');
  });

  it('assigns the selected build to a loadout slot', () => {
    const { save, onChange } = open();
    const carryTwo = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Carry as 2');
    act(() => carryTwo?.click());
    expect((onChange.mock.calls.at(-1)![0] as SaveDataV6).loadout).toEqual([save.armory[0].id, save.armory[0].id]);
  });

  it('adds a build and refuses to empty the armory', () => {
    const { onChange } = open();
    const add = [...container.querySelectorAll('button')].find((button) => button.textContent === 'New build');
    act(() => add?.click());
    expect((onChange.mock.calls.at(-1)![0] as SaveDataV6).armory).toHaveLength(3);

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
