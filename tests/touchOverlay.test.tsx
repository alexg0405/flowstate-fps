import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Action } from '../src/contracts';
import type { TouchInput } from '../src/input/InputController';
import { TouchControls } from '../src/game/TouchControls';

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
  // jsdom has no pointer capture, and every control here takes it so that a thumb that
  // slides off a button still releases the bit it pressed.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function recorder(): TouchInput & { pressed: number[]; released: number[]; moves: number[]; looks: [number, number][] } {
  const pressed: number[] = [];
  const released: number[] = [];
  const moves: number[] = [];
  const looks: [number, number][] = [];
  return {
    pressed, released, moves, looks,
    press: (action) => pressed.push(action),
    release: (action) => released.push(action),
    move: (actions) => moves.push(actions),
    look: (dx, dy) => looks.push([dx, dy]),
  };
}

/** A pointer event jsdom will actually dispatch, with the fields React reads. */
function pointer(type: string, init: { pointerId?: number; clientX?: number; clientY?: number } = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0 });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  return event;
}

const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('the on-screen control scheme', () => {
  it('holds a bit down rather than firing it on release', () => {
    const input = recorder();
    render(<TouchControls input={input} grappling={false} gunInHand={false} onPause={() => {}} />);
    const cut = button('Slash')!;
    expect(cut).toBeTruthy();
    act(() => { cut.dispatchEvent(pointer('pointerdown')); });
    // A cut that waited for the finger to lift would be a quarter of a second late, and
    // the hook would be wrong in a way the player could not work around at all.
    expect(input.pressed).toEqual([Action.Slash]);
    expect(input.released).toEqual([]);
    expect(cut.getAttribute('aria-pressed')).toBe('true');
    act(() => { cut.dispatchEvent(pointer('pointerup')); });
    expect(input.released).toEqual([Action.Slash]);
  });

  it('turns a drag into look, in the units the sensitivity setting is in', () => {
    const input = recorder();
    render(<TouchControls input={input} grappling={false} gunInHand={false} onPause={() => {}} />);
    const look = container.querySelector<HTMLElement>('.touch-look')!;
    act(() => { look.dispatchEvent(pointer('pointerdown', { clientX: 200, clientY: 100 })); });
    act(() => { look.dispatchEvent(pointer('pointermove', { clientX: 214, clientY: 92 })); });
    expect(input.looks).toEqual([[14, -8]]);
  });

  it('lets a second thumb move while the first is looking', () => {
    const input = recorder();
    render(<TouchControls input={input} grappling={false} gunInHand={false} onPause={() => {}} />);
    const look = container.querySelector<HTMLElement>('.touch-look')!;
    const stick = container.querySelector<HTMLElement>('.touch-stick-zone')!;
    act(() => { look.dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 400, clientY: 200 })); });
    act(() => { stick.dispatchEvent(pointer('pointerdown', { pointerId: 2, clientX: 90, clientY: 300 })); });
    act(() => { stick.dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: 90, clientY: 240 })); });
    act(() => { look.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 420, clientY: 200 })); });
    // Moving, looking and doing both at once is the most ordinary moment this game has.
    expect(input.moves.at(-1)! & Action.Forward).toBe(Action.Forward);
    expect(input.looks.at(-1)).toEqual([20, 0]);
  });

  it('lets go of a contextual control that disappears while it is held', () => {
    const input = recorder();
    render(<TouchControls input={input} grappling gunInHand={false} onPause={() => {}} />);
    const pull = button('Pull along the hook')!;
    act(() => { pull.dispatchEvent(pointer('pointerdown')); });
    expect(input.pressed).toEqual([Action.GrapplePull]);
    // The hook lets go, so the button goes -- and the bit has to go with it or the
    // action stays held for the rest of the run.
    render(<TouchControls input={input} grappling={false} gunInHand={false} onPause={() => {}} />);
    expect(button('Pull along the hook')).toBeNull();
    expect(input.released).toEqual([Action.GrapplePull]);
  });

  it('releases everything when the overlay itself goes away', () => {
    const input = recorder();
    render(<TouchControls input={input} grappling={false} gunInHand={false} onPause={() => {}} />);
    act(() => { button('Jump, and twice to dash')!.dispatchEvent(pointer('pointerdown')); });
    act(() => root.render(null));
    // Coming back from the pause card still sprinting into a wall is the bug this
    // prevents, and it is not one the player can undo.
    expect(input.moves.at(-1)).toBe(0);
    expect(input.released).toContain(Action.Jump);
  });

  it('offers a way out, because there is no Escape key on a phone', () => {
    const input = recorder();
    const paused = vi.fn();
    render(<TouchControls input={input} grappling={false} gunInHand={false} onPause={paused} />);
    act(() => { button('Pause the run')!.dispatchEvent(pointer('pointerdown')); });
    expect(paused).toHaveBeenCalled();
  });
});
