import { describe, expect, it, vi } from 'vitest';
import { Action } from '../src/contracts';
import { InputController } from '../src/input/InputController';
import {
  observeTouchControls,
  prefersTouchControls,
  readStick,
  stickGeometry,
  touchButtons,
  visibleTouchButtons,
} from '../src/input/touchControls';

/** A thumb `distance` from the origin at `degrees` clockwise from straight up. */
function thumb(degrees: number, fraction: number) {
  const radians = (degrees * Math.PI) / 180;
  const distance = stickGeometry.radius * fraction;
  return readStick(Math.sin(radians) * distance, -Math.cos(radians) * distance);
}

describe('the thumbstick', () => {
  it('reads nothing at all inside the deadzone', () => {
    // The single worst thing a touch scheme can do to a movement game is walk the player
    // off a rooftop because a resting thumb drifted, so the deadzone is generous.
    expect(thumb(0, stickGeometry.deadzone * 0.9).actions).toBe(0);
    expect(thumb(0, stickGeometry.deadzone * 1.4).actions).toBe(Action.Forward);
  });

  it('gives eight even directions rather than four wide ones and four gaps', () => {
    expect(thumb(0, 0.6).actions).toBe(Action.Forward);
    expect(thumb(45, 0.6).actions).toBe(Action.Forward | Action.Right);
    expect(thumb(90, 0.6).actions).toBe(Action.Right);
    expect(thumb(135, 0.6).actions).toBe(Action.Back | Action.Right);
    expect(thumb(180, 0.6).actions).toBe(Action.Back);
    expect(thumb(225, 0.6).actions).toBe(Action.Back | Action.Left);
    expect(thumb(270, 0.6).actions).toBe(Action.Left);
    expect(thumb(315, 0.6).actions).toBe(Action.Forward | Action.Left);
  });

  it('sprints only at the edge of the throw, so it stays a commitment', () => {
    expect(thumb(0, 0.7).actions & Action.Sprint).toBe(0);
    expect(thumb(0, 1).actions & Action.Sprint).toBe(Action.Sprint);
    // And it is still a direction, not a mode.
    expect(thumb(0, 1).actions & Action.Forward).toBe(Action.Forward);
  });

  it('clamps the knob to the throw however far the thumb travels', () => {
    const far = readStick(0, -stickGeometry.radius * 5);
    expect(far.magnitude).toBe(1);
    expect(Math.hypot(...far.knee)).toBeCloseTo(stickGeometry.radius, 6);
  });
});

describe('which controls are drawn', () => {
  it('keeps the hook pull off the frame until there is a hook to pull on', () => {
    const idle = visibleTouchButtons({ grappling: false, gunInHand: false });
    const hooked = visibleTouchButtons({ grappling: true, gunInHand: false });
    expect(idle.some((button) => button.id === 'pull')).toBe(false);
    expect(hooked.some((button) => button.id === 'pull')).toBe(true);
  });

  it('does not offer a magazine to a player holding a blade', () => {
    const blade = visibleTouchButtons({ grappling: false, gunInHand: false });
    const gun = visibleTouchButtons({ grappling: false, gunInHand: true });
    expect(blade.some((button) => button.id === 'reload')).toBe(false);
    expect(gun.some((button) => button.id === 'reload')).toBe(true);
  });

  it('has no dash button, because a dash is a double-tapped jump on every device', () => {
    // The simulation derives the dash and the perfect dodge from the same edge whatever
    // pressed it. A button of its own would be a second way to spend one charge.
    expect(touchButtons.some((button) => button.action === Action.Dash)).toBe(false);
    expect(touchButtons.some((button) => button.action === Action.Jump)).toBe(true);
  });

  it('reaches every verb the keyboard scheme does, bar the two slot keys', () => {
    const reachable = touchButtons.reduce((mask, button) => mask | button.action, 0);
    for (const action of [Action.Attack, Action.Melee, Action.Jump, Action.Crouch, Action.Grapple, Action.GrapplePull, Action.Reload, Action.Ads, Action.WeaponSwap]) {
      expect(reachable & action).toBe(action);
    }
  });
});

describe('choosing the scheme', () => {
  const stubMedia = (coarse: boolean) => {
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('coarse') ? coarse : false,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    return listeners;
  };

  it('asks about the primary pointer, not any pointer', () => {
    // `any-pointer: coarse` is true of every touchscreen laptop in existence, and a
    // thumbstick over the HUD of one is the failure this distinction exists to avoid.
    stubMedia(true);
    expect(prefersTouchControls()).toBe(true);
    stubMedia(false);
    expect(prefersTouchControls()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('follows the answer changing, and stops following when told to', () => {
    const listeners = stubMedia(true);
    const seen: boolean[] = [];
    const stop = observeTouchControls((touch) => seen.push(touch));
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener();
    expect(seen).toEqual([true]);
    stop();
    expect(listeners.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('says no on a platform with no media queries at all', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersTouchControls()).toBe(false);
    expect(() => observeTouchControls(() => {})()).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('touch reaches the simulation the same way a keyboard does', () => {
  const engaged = () => {
    const canvas = document.createElement('canvas');
    canvas.requestPointerLock = vi.fn();
    const input = new InputController(canvas);
    input.engageTouch();
    return { input, canvas };
  };

  it('engages without Pointer Lock, because a phone has no pointer to lock', () => {
    const { input, canvas } = engaged();
    expect(input.isLocked()).toBe(true);
    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    input.dispose();
  });

  it('turns the stick into press and release edges rather than a written mask', () => {
    const { input } = engaged();
    input.touch.move(Action.Forward | Action.Right);
    const first = input.frame(1);
    expect(first.pressed).toBe(Action.Forward | Action.Right);
    expect(first.held).toBe(Action.Forward | Action.Right);

    // Rolling the thumb from forward-right to forward: one bit goes, one stays, and the
    // simulation has to see the release as an edge or the player keeps strafing.
    input.touch.move(Action.Forward);
    const second = input.frame(2);
    expect(second.released).toBe(Action.Right);
    expect(second.held).toBe(Action.Forward);
    input.dispose();
  });

  it('leaves everything but the movement bits alone when the stick moves', () => {
    const { input } = engaged();
    input.touch.press(Action.Attack);
    input.touch.move(Action.Forward);
    // A thumb on `CUT` and a thumb on the stick are two fingers doing two things, which
    // is the most ordinary moment this game has.
    expect(input.frame(1).held & Action.Attack).toBe(Action.Attack);
    expect(input.frame(2).held & Action.Forward).toBe(Action.Forward);
    input.dispose();
  });

  it('accumulates a drag the way a mouse accumulates movement', () => {
    const { input } = engaged();
    input.touch.look(12, -4);
    input.touch.look(3, 1);
    expect(input.frame(1).look).toEqual([15, -3]);
    // And a frame consumes it, so a held thumb that stops moving stops turning the view.
    expect(input.frame(2).look).toEqual([0, 0]);
    input.dispose();
  });

  it('hands the run back on a button, since there is no Escape key to press', () => {
    const { input } = engaged();
    input.touch.press(Action.Attack);
    input.release();
    expect(input.isLocked()).toBe(false);
    // Whatever was held is reported released once, so a bit cannot survive the pause.
    expect(input.frame(1).released & Action.Attack).toBe(Action.Attack);
    // And nothing a thumb does while paused reaches the simulation.
    input.touch.press(Action.Jump);
    expect(input.frame(2).held).toBe(0);
    input.dispose();
  });
});
