import { Action } from '../contracts';

/**
 * Touch input, as data and arithmetic rather than as a component.
 *
 * Everything here is pure and testable: whether this device wants an on-screen control
 * scheme at all, what a thumb at a given offset from a stick's origin is asking for, and
 * which buttons exist. `game/TouchControls.tsx` renders it and nothing else.
 *
 * The reason the stick is arithmetic rather than an analogue axis is the contract. The
 * simulation takes a bitmask -- `Action.Forward` and friends -- because the movement
 * motor is momentum-free on the ground and snaps velocity to the input, which is the
 * decision the whole movement kit is built on. An analogue stick would have to be
 * quantised somewhere; doing it here keeps the simulation identical on every device,
 * which is also what keeps `simulationReplay` honest.
 */

/**
 * Whether this device should be driven by touch.
 *
 * `pointer: coarse` describes the device's **primary** pointer, which is the question
 * being asked -- a laptop with a touchscreen and a trackpad reports `fine` and keeps the
 * keyboard scheme, while a phone or a tablet reports `coarse` and gets the overlay. The
 * looser `any-pointer: coarse` would put a thumbstick over the HUD of every touchscreen
 * laptop in existence.
 */
export function prefersTouchControls(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches;
}

/** Calls back whenever the answer to `prefersTouchControls` changes. */
export function observeTouchControls(onChange: (touch: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia('(pointer: coarse)');
  const listener = () => onChange(query.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/**
 * The stick.
 *
 * `radius` is the throw in CSS pixels -- how far the thumb travels for a full deflection.
 * `deadzone` is the fraction of it that reads as nothing, and it is generous on purpose:
 * a thumb resting on glass drifts, and a drifting thumb that walks the player off a
 * rooftop is the single worst thing a touch scheme can do to this game.
 *
 * `axisThreshold` is what makes it eight-way. A direction is claimed by an axis once its
 * unit component passes the threshold, so 0.38 gives 45-degree cardinal bands and
 * 45-degree diagonal ones -- even bands, which is what a thumb can actually hit.
 */
export const stickGeometry = {
  radius: 58,
  deadzone: 0.26,
  axisThreshold: 0.38,
  /** Deflection past which the player is sprinting. Near the edge: it is a commitment. */
  sprintFrom: 0.86,
} as const;

export interface StickReading {
  /** Movement bits, ready to hand to the simulation. */
  actions: number;
  /** 0 to 1, for drawing the knob. */
  magnitude: number;
  /** Knob offset in CSS pixels, clamped to the throw. */
  knee: readonly [number, number];
}

export function readStick(dx: number, dy: number): StickReading {
  const distance = Math.hypot(dx, dy);
  const magnitude = Math.min(1, distance / stickGeometry.radius);
  const clamped = distance === 0 ? 1 : Math.min(1, stickGeometry.radius / distance);
  const knee = [dx * clamped, dy * clamped] as const;
  if (magnitude < stickGeometry.deadzone || distance === 0) return { actions: 0, magnitude, knee };
  const x = dx / distance;
  const y = dy / distance;
  let actions = 0;
  // Screen y grows downwards, so forward is negative.
  if (-y > stickGeometry.axisThreshold) actions |= Action.Forward;
  if (y > stickGeometry.axisThreshold) actions |= Action.Back;
  if (-x > stickGeometry.axisThreshold) actions |= Action.Left;
  if (x > stickGeometry.axisThreshold) actions |= Action.Right;
  if (magnitude >= stickGeometry.sprintFrom) actions |= Action.Sprint;
  return { actions, magnitude, knee };
}

/**
 * When a button is drawn.
 *
 * `always` is most of them. The two conditional ones are the reason this is a field
 * rather than a comment: `PULL` is meaningless unless a hook is out, and a magazine the
 * player is not holding is not something to reload. A phone has room for about eight
 * controls under a thumb, and the two contextual ones are how it holds ten.
 */
export type TouchCondition = 'always' | 'grappling' | 'gun';

export interface TouchButton {
  id: string;
  label: string;
  /** What the button says it does, for the accessible name. */
  description: string;
  action: number;
  condition: TouchCondition;
  /** Which cluster it belongs to. See the stylesheet for where each one sits. */
  zone: 'primary' | 'secondary' | 'utility';
}

/**
 * The scheme.
 *
 * Ordered by how often the player presses it, because that is the order of how far the
 * thumb has to travel. The blade is the primary verb, so `CUT` is the largest control on
 * screen and sits where the thumb already rests; the gun is a secondary and sits beside
 * it. Everything the player presses between fights -- reload, swap, aim -- is a small
 * strip at the top of the right hand, out of the way of the arc the thumb sweeps.
 *
 * There is no dash button, deliberately, and no dodge button either. Both are a
 * double-tapped jump, and the simulation derives them from the same edge on every input
 * device -- a separate button would be a second way to spend a charge the player is
 * already spending, which is how a mobile scheme ends up with two verbs that fight.
 */
export const touchButtons: readonly TouchButton[] = [
  { id: 'slash', label: 'CUT', description: 'Slash', action: Action.Slash, condition: 'always', zone: 'primary' },
  { id: 'jump', label: 'JUMP', description: 'Jump, and twice to dash', action: Action.Jump, condition: 'always', zone: 'primary' },
  { id: 'heavy', label: 'HEAVY', description: 'Heavy swing', action: Action.Melee, condition: 'always', zone: 'primary' },
  { id: 'fire', label: 'GUN', description: 'Fire the sidearm', action: Action.Fire, condition: 'always', zone: 'primary' },
  { id: 'hook', label: 'HOOK', description: 'Cast the hook', action: Action.Grapple, condition: 'always', zone: 'secondary' },
  { id: 'pull', label: 'PULL', description: 'Pull along the hook', action: Action.GrapplePull, condition: 'grappling', zone: 'secondary' },
  { id: 'slide', label: 'SLIDE', description: 'Slide', action: Action.Crouch, condition: 'always', zone: 'secondary' },
  { id: 'aim', label: 'AIM', description: 'Aim down sights', action: Action.Ads, condition: 'gun', zone: 'utility' },
  { id: 'reload', label: 'RELOAD', description: 'Reload', action: Action.Reload, condition: 'gun', zone: 'utility' },
  { id: 'swap', label: 'SWAP', description: 'Swap weapon', action: Action.WeaponSwap, condition: 'always', zone: 'utility' },
];

/** Which of the buttons are drawn right now. */
export function visibleTouchButtons(state: { grappling: boolean; gunInHand: boolean }): readonly TouchButton[] {
  return touchButtons.filter((button) => (
    button.condition === 'always'
    || (button.condition === 'grappling' && state.grappling)
    || (button.condition === 'gun' && state.gunInHand)
  ));
}
