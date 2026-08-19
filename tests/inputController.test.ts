import { describe, expect, it, vi } from 'vitest';
import { Action } from '../src/contracts';
import { InputController } from '../src/input/InputController';

describe('input focus safety', () => {
  it('ignores overlay keys and provides an escapeable embedded-preview fallback', async () => {
    const canvas = document.createElement('canvas');
    canvas.requestPointerLock = vi.fn().mockRejectedValue(new DOMException('Unavailable'));
    const input = new InputController(canvas);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(input.frame(1).held).toBe(0);

    await input.requestLock();
    expect(input.isLocked()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(input.frame(2).held & Action.Forward).toBe(Action.Forward);
    window.dispatchEvent(new Event('blur'));
    expect(input.isLocked()).toBe(false);
    expect(input.frame(3).held).toBe(0);
    input.dispose();
  });

  it('keeps a repeated tap as two edges when both arrive inside one frame', async () => {
    const canvas = document.createElement('canvas');
    canvas.requestPointerLock = vi.fn().mockRejectedValue(new DOMException('Unavailable'));
    const input = new InputController(canvas);
    await input.requestLock();

    // `requestAnimationFrame` throttles to 15 Hz in a backgrounded tab, so the whole
    // double tap can land between two callbacks and the runtime then owes several
    // fixed steps at once. Merging the edges lost the second press and the dash.
    const tap = () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
    };
    tap();
    tap();

    const first = input.frame(1);
    const second = input.frame(2);
    expect(first.pressed & Action.Jump).toBe(Action.Jump);
    expect(second.pressed & Action.Jump).toBe(Action.Jump);
    // Drained, so a held key still reports and nothing replays.
    expect(input.frame(3).pressed).toBe(0);
    expect(input.frame(3).held).toBe(0);
    input.dispose();
  });

  it('reports a held key on every step once its edges are drained', async () => {
    const canvas = document.createElement('canvas');
    canvas.requestPointerLock = vi.fn().mockRejectedValue(new DOMException('Unavailable'));
    const input = new InputController(canvas);
    await input.requestLock();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));

    expect(input.frame(1).pressed & Action.Forward).toBe(Action.Forward);
    for (const tick of [2, 3, 4]) {
      const frame = input.frame(tick);
      expect(frame.held & Action.Forward).toBe(Action.Forward);
      expect(frame.pressed).toBe(0);
    }
    input.dispose();
  });
});
