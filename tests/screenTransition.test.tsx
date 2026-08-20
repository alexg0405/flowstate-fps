import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { defaultArmory } from '../src/content/weapons';
import { presentation } from '../src/content/config';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  document.documentElement.className = '';
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

function seedSave(reducedMotion: boolean): void {
  const armory = defaultArmory();
  localStorage.setItem('flowstate-fps-save-v1', JSON.stringify({
    schemaVersion: 4,
    settings: { sensitivity: 0.002, fov: 92, cameraRoll: 0.65, headBob: 0.35, shake: 0.5, renderScale: 1, debug: false, reducedMotion, graphicsQuality: 'auto', dynamicResolution: true },
    bestRun: null,
    bestTimeSeconds: null,
    armory,
    loadout: [armory[0].id, armory[1].id],
  }));
}

function click(selector: string): void {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Expected the DOM to contain "${selector}".`);
  act(() => button.click());
}

describe('between-screen transition', () => {
  it('carries a wipe across the frame when the screen changes', () => {
    seedSave(false);
    render(<App />);
    expect(container.querySelector('.screen-wipe')).toBeNull();

    click('button[aria-label="Open gun builder"]');
    // The new screen is mounted immediately; nothing waits on the transition.
    expect(container.querySelector('.builder-shell')).not.toBeNull();
    const wipe = container.querySelector('.screen-wipe');
    expect(wipe).not.toBeNull();
    // Decorative throughout: it is announced to nobody and it swallows no clicks.
    expect(wipe?.getAttribute('aria-hidden')).toBe('true');
    expect(wipe?.querySelector('.wipe-mark')?.textContent).toBe('FLOW/STATE');
    // The stagger CSS animates off comes from `content/config.ts`, not a second copy.
    expect((wipe as HTMLElement).style.getPropertyValue('--wipe')).toBe(`${presentation.wipeSeconds}s`);
  });

  it('takes the wipe down when its own sweep ends, not when a child animation does', () => {
    seedSave(false);
    render(<App />);
    click('button[aria-label="Open gun builder"]');
    const wipe = container.querySelector('.screen-wipe') as HTMLElement;

    // jsdom has no `AnimationEvent`; React dispatches off the native event name.
    act(() => { wipe.querySelector('.wipe-mark')!.dispatchEvent(new Event('animationend', { bubbles: true })); });
    expect(container.querySelector('.screen-wipe')).not.toBeNull();

    act(() => { wipe.dispatchEvent(new Event('animationend', { bubbles: true })); });
    expect(container.querySelector('.screen-wipe')).toBeNull();
  });

  it('restarts the sweep on a second move rather than reusing a spent element', () => {
    seedSave(false);
    render(<App />);
    click('button[aria-label="Open gun builder"]');
    const first = container.querySelector('.screen-wipe');
    click('.builder-header button');
    const second = container.querySelector('.screen-wipe');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('never raises a wipe when reduced motion is on, and marks the root for the rest', () => {
    seedSave(true);
    render(<App />);
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
    click('button[aria-label="Open gun builder"]');
    expect(container.querySelector('.builder-shell')).not.toBeNull();
    expect(container.querySelector('.screen-wipe')).toBeNull();
  });
});
