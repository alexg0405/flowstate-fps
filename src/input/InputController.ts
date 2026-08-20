import { Action, type InputFrame } from '../contracts';

const keyActions: Record<string, number> = {
  KeyW: Action.Forward,
  KeyS: Action.Back,
  KeyA: Action.Left,
  KeyD: Action.Right,
  Space: Action.Jump,
  ShiftLeft: Action.Sprint,
  ShiftRight: Action.Sprint,
  ControlLeft: Action.Crouch,
  KeyC: Action.Crouch,
  // Dash has no dedicated key: the simulation derives it from a double-tapped jump.
  KeyQ: Action.GrapplePull,
  KeyR: Action.Reload,
  // `Action.Melee` is deliberately unbound: the blade moved to the left mouse button
  // and the bit is being held for the heavy that follows it.
  KeyV: Action.Ads,
  KeyF: Action.Grapple,
  Digit1: Action.WeaponPrimary,
  Digit2: Action.WeaponSecondary,
  Tab: Action.WeaponSwap,
};

/**
 * One simulation sample's worth of input. Edges are queued rather than merged into
 * a single mask because the runtime can owe several fixed steps for one animation
 * frame: `requestAnimationFrame` throttles to 15 Hz in a backgrounded or offscreen
 * tab, and at that rate a 60 ms double tap arrives entirely between two callbacks.
 * Merging lost the second press, so the dash simply did not happen.
 */
interface InputSegment {
  pressed: number;
  released: number;
  held: number;
}

/**
 * Ceiling on queued samples. The simulation drains one per step, so this only ever
 * matters if input arrives while nothing is stepping.
 */
const MAX_SEGMENTS = 8;

export class InputController {
  private held = 0;
  private segments: InputSegment[] = [];
  private lookX = 0;
  private lookY = 0;
  private locked = false;
  private softLocked = false;
  private readonly onLockChangeCallbacks = new Set<(locked: boolean) => void>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('blur', this.suspendInput);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    canvas.addEventListener('contextmenu', this.preventContextMenu);
  }

  onLockChange(callback: (locked: boolean) => void): () => void {
    this.onLockChangeCallbacks.add(callback);
    return () => this.onLockChangeCallbacks.delete(callback);
  }

  async requestLock(): Promise<void> {
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try {
        await this.canvas.requestPointerLock();
      } catch {
        // Embedded IDE previews and headless browsers can reject Pointer Lock even
        // after a user gesture. Keep keyboard controls and bounded mouse-look usable.
        this.softLocked = true;
        this.locked = true;
        this.canvas.tabIndex = 0;
        this.canvas.focus();
        for (const callback of this.onLockChangeCallbacks) callback(true);
      }
    }
  }

  frame(tick: number): InputFrame {
    // Oldest sample first, so a press/release/press sequence reaches the simulation
    // as three ordered edges however few frames it arrived across.
    const segment = this.segments.shift();
    const frame: InputFrame = {
      tick,
      held: segment ? segment.held : this.held,
      pressed: segment?.pressed ?? 0,
      released: segment?.released ?? 0,
      look: [this.lookX, this.lookY],
    };
    this.lookX = 0;
    this.lookY = 0;
    return frame;
  }

  isLocked(): boolean {
    return this.locked;
  }

  clear = (): void => {
    const releasing = this.held;
    this.held = 0;
    // Anything still down is reported as released once, so state that only unwinds
    // on an edge does not survive losing focus.
    this.segments = releasing ? [{ pressed: 0, released: releasing, held: 0 }] : [];
    this.lookX = 0;
    this.lookY = 0;
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('blur', this.suspendInput);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
  }

  /**
   * Routes an edge to the newest queued sample, or opens a new one when that sample
   * already carries the same edge for the same action. That split is what keeps a
   * repeated tap from collapsing into one press.
   */
  private recordPress(action: number): void {
    this.held |= action;
    const segment = this.segmentFor(action, 'pressed');
    segment.pressed |= action;
    segment.held = this.held;
  }

  private recordRelease(action: number): void {
    this.held &= ~action;
    // Releases only need queueing while the simulation is consuming samples; out of
    // lock, dropping the held bit is enough and nothing accumulates.
    if (!this.locked) return;
    const segment = this.segmentFor(action, 'released');
    segment.released |= action;
    segment.held = this.held;
  }

  private segmentFor(action: number, kind: 'pressed' | 'released'): InputSegment {
    const last = this.segments.at(-1);
    if (last && !(last[kind] & action)) return last;
    if (last && this.segments.length >= MAX_SEGMENTS) return last;
    const segment: InputSegment = { pressed: 0, released: 0, held: this.held };
    this.segments.push(segment);
    return segment;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape' && this.softLocked) {
      this.suspendInput();
      return;
    }
    if (!this.locked) return;
    const action = keyActions[event.code];
    if (!action || event.repeat) return;
    this.recordPress(action);
    if (['Space', 'ControlLeft', 'Tab'].includes(event.code)) event.preventDefault();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const action = keyActions[event.code];
    if (!action) return;
    this.recordRelease(action);
  };

  /**
   * Left is the blade, right is the sidearm. Aiming came off the mouse entirely and
   * onto `KeyV`: with melee as the primary verb there are three attack-adjacent verbs
   * and two mouse buttons, and the one a player uses least is the deliberate,
   * stand-still zoom.
   */
  private mouseAction(button: number): number {
    return button === 0 ? Action.Slash : button === 2 ? Action.Fire : 0;
  }

  private onMouseDown = (event: MouseEvent): void => {
    if (!this.locked) return;
    const action = this.mouseAction(event.button);
    if (action) this.recordPress(action);
  };

  private onMouseUp = (event: MouseEvent): void => {
    const action = this.mouseAction(event.button);
    if (action) this.recordRelease(action);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.lookX += event.movementX;
    this.lookY += event.movementY;
  };

  private onPointerLockChange = (): void => {
    const pointerLocked = document.pointerLockElement === this.canvas;
    if (!pointerLocked && this.softLocked) return;
    this.softLocked = false;
    this.locked = pointerLocked;
    if (!this.locked) this.clear();
    for (const callback of this.onLockChangeCallbacks) callback(this.locked);
  };

  private onVisibility = (): void => {
    if (document.hidden) this.suspendInput();
  };

  private suspendInput = (): void => {
    this.clear();
    const wasLocked = this.locked;
    this.softLocked = false;
    this.locked = false;
    if (document.pointerLockElement === this.canvas && typeof document.exitPointerLock === 'function') document.exitPointerLock();
    if (wasLocked) for (const callback of this.onLockChangeCallbacks) callback(false);
  };

  private preventContextMenu = (event: Event): void => event.preventDefault();
}
