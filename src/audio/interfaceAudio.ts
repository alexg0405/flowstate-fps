import { AudioManager, type UiCue } from './AudioManager';

/**
 * The interface's own voice on the synth bus.
 *
 * A separate `AudioManager` from the one `GameRuntime` owns, and deliberately so:
 * that one is created and disposed with the run, and disposing it closes its
 * `AudioContext`. Sharing it would mean the menu went silent the moment a run ended,
 * which is exactly when the player is back in the menu. This one lives as long as
 * the tab does. It is the same class, so both use the same two synth primitives and
 * the same deterministic noise buffer.
 */
let bus: AudioManager | null = null;
/** Whether a gesture has unlocked the context yet. Browsers require one. */
let unlocking: Promise<void> | null = null;

function ensure(): AudioManager {
  bus ??= new AudioManager();
  return bus;
}

/**
 * Plays a cue if the bus is awake. Never awaits: a menu sound is not worth delaying
 * the press that caused it, and the first press of a session is silent by design --
 * the context cannot legally start before a gesture, and that gesture is this one.
 */
export function playUiCue(kind: UiCue): void {
  ensure().cue(kind);
}

/**
 * The player's level, for the bus the interface shares.
 *
 * The run's own `AudioManager` is set from the same save field by `GameRuntime`; this
 * one has to be told separately because it deliberately outlives every run. Called on
 * mount and on every settings change, so a slider dragged on the pause card also
 * quietens the menu the player backs out to.
 */
export function setInterfaceVolume(volume: number): void {
  ensure().setVolume(volume);
}

/**
 * Wires the whole interface to the mix in one place.
 *
 * Delegated from the document rather than threaded through every component, because
 * the alternative is a prop on `MainMenu`, `GameOverlay`, `WeaponBuilder` and the
 * editor's toolbars, all to say the same thing. It also means a button added later
 * is acknowledged without anyone remembering to wire it up.
 *
 * Returns a disposer.
 */
export function installInterfaceAudio(): () => void {
  if (typeof document !== 'object') return () => {};
  let lastHovered: Element | null = null;

  const wake = () => {
    // Started on the first gesture and never again; `resume` is idempotent but the
    // promise is kept so a burst of clicks does not open a context per click.
    unlocking ??= ensure().resume();
  };

  const onPointerOver = (event: Event) => {
    const button = actionable(event.target);
    if (!button || button === lastHovered) return;
    lastHovered = button;
    playUiCue('hover');
  };

  const onPointerOut = (event: Event) => {
    if (actionable(event.target) === lastHovered) lastHovered = null;
  };

  const onPointerDown = (event: Event) => {
    wake();
    const button = actionable(event.target);
    if (button) playUiCue(cueFor(button));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    wake();
    // Only the keys that actually operate a control, so typing a build name into the
    // bench does not play a note per character.
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const button = actionable(document.activeElement);
    if (button) playUiCue(cueFor(button));
  };

  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('pointerover', onPointerOver, true);
    document.removeEventListener('pointerout', onPointerOut, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };
}

/** The enabled control an event landed on, or null if it landed on anything else. */
function actionable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest<HTMLElement>('button, summary, [role="tab"]');
  if (!control || (control instanceof HTMLButtonElement && control.disabled)) return null;
  return control;
}

/**
 * Which acknowledgement a control earns. Read off the classes the stylesheet already
 * uses for tone, so the sound and the colour cannot drift apart: a button that looks
 * like the primary action sounds like one.
 */
export function cueFor(control: Element): UiCue {
  if (control.matches('.danger, .tone-danger, .exit-action, .icon-button')) return 'cancel';
  if (control.matches('.primary, .tone-primary')) return 'confirm';
  return 'select';
}
