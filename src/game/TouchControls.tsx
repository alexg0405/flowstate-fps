import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { TouchInput } from '../input/InputController';
import { readStick, stickGeometry, touchButtons, visibleTouchButtons, type TouchButton } from '../input/touchControls';

/**
 * The on-screen control scheme.
 *
 * Three surfaces, and the split between them is the whole design. A **look layer** covers
 * the frame and turns a drag into the same movement a mouse reports. A **stick** appears
 * wherever the left thumb lands, because a fixed one is a control the player has to look
 * at and this game is played at fourteen metres a second. And a **button cluster** sits
 * under the right thumb, ordered by how often it is pressed.
 *
 * Everything here is pointer events with explicit capture, never touch events: capture is
 * what lets the stick, the look drag and a button all be live at once, which they have to
 * be -- this game's most ordinary moment is moving, looking and cutting on the same
 * frame, and a scheme that serialises those is a scheme that cannot play it.
 *
 * Nothing here holds gameplay state. It converts a thumb into the same three verbs the
 * keyboard produces and hands them to `TouchInput`.
 */
interface TouchControlsProps {
  input: TouchInput;
  /** Whether a hook is out, which is the only time `PULL` means anything. */
  grappling: boolean;
  /** Whether the gun is up, which is the only time a magazine is worth a button. */
  gunInHand: boolean;
  /** Hands the run back. There is no `Escape` key to do it with. */
  onPause: () => void;
}

interface StickState {
  pointerId: number;
  originX: number;
  originY: number;
  knee: readonly [number, number];
  magnitude: number;
}

export function TouchControls({ input, grappling, gunInHand, onPause }: TouchControlsProps) {
  const [stick, setStick] = useState<StickState | null>(null);
  /** Live look pointers, so two thumbs on the right half do not fight over the view. */
  const looking = useRef(new Map<number, { x: number; y: number }>());
  const visible = visibleTouchButtons({ grappling, gunInHand });

  // Anything still held when the overlay goes away has to be let go of, or the player
  // comes back from the pause card still sprinting into a wall. Every button in the
  // scheme rather than the visible ones: which are visible is exactly what may have
  // changed on the frame this runs.
  useEffect(() => () => {
    input.move(0);
    for (const button of touchButtons) input.release(button.action);
  }, [input]);

  const beginStick = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setStick({ pointerId: event.pointerId, originX: event.clientX, originY: event.clientY, knee: [0, 0], magnitude: 0 });
  }, []);

  const moveStick = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    setStick((current) => {
      if (!current || current.pointerId !== event.pointerId) return current;
      const reading = readStick(event.clientX - current.originX, event.clientY - current.originY);
      input.move(reading.actions);
      return { ...current, knee: reading.knee, magnitude: reading.magnitude };
    });
  }, [input]);

  const endStick = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    setStick((current) => {
      if (!current || current.pointerId !== event.pointerId) return current;
      input.move(0);
      return null;
    });
  }, [input]);

  const beginLook = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    looking.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }, []);

  const moveLook = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const last = looking.current.get(event.pointerId);
    if (!last) return;
    // The same units a mouse reports, so the sensitivity slider means one thing on both
    // schemes and a player who moves between them keeps their setting.
    input.look(event.clientX - last.x, event.clientY - last.y);
    looking.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }, [input]);

  const endLook = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    looking.current.delete(event.pointerId);
  }, []);

  return (
    <div className="touch-controls" data-testid="touch-controls">
      {/* Under everything else, so a thumb on a button never also turns the view. */}
      <div
        className="touch-look"
        aria-hidden="true"
        onPointerDown={beginLook}
        onPointerMove={moveLook}
        onPointerUp={endLook}
        onPointerCancel={endLook}
      />
      <div
        className="touch-stick-zone"
        aria-label="Movement stick"
        role="application"
        onPointerDown={beginStick}
        onPointerMove={moveStick}
        onPointerUp={endStick}
        onPointerCancel={endStick}
      >
        {stick && (
          <div
            className={`touch-stick ${stick.magnitude >= stickGeometry.sprintFrom ? 'is-sprinting' : ''}`}
            style={{ left: `${stick.originX}px`, top: `${stick.originY}px`, '--throw': `${stickGeometry.radius}px` } as CSSProperties}
            aria-hidden="true"
          >
            <i className="touch-stick-ring" />
            <i className="touch-stick-knob" style={{ transform: `translate(${stick.knee[0]}px, ${stick.knee[1]}px)` }} />
          </div>
        )}
      </div>
      <div className="touch-cluster touch-cluster-utility">
        <button type="button" className="touch-button is-utility" aria-label="Pause the run" onPointerDown={onPause}>PAUSE</button>
        {visible.filter((button) => button.zone === 'utility').map((button) => (
          <TouchAction key={button.id} button={button} input={input} />
        ))}
      </div>
      <div className="touch-cluster touch-cluster-secondary">
        {visible.filter((button) => button.zone === 'secondary').map((button) => (
          <TouchAction key={button.id} button={button} input={input} />
        ))}
      </div>
      <div className="touch-cluster touch-cluster-primary">
        {visible.filter((button) => button.zone === 'primary').map((button) => (
          <TouchAction key={button.id} button={button} input={input} />
        ))}
      </div>
    </div>
  );
}

/**
 * One control. Held rather than clicked: every verb in this game is a bit that is down or
 * up, and a `click` handler would fire on release, which is half a second late for a cut
 * and completely wrong for the hook.
 */
function TouchAction({ button, input }: { button: TouchButton; input: TouchInput }) {
  const [down, setDown] = useState(false);
  const pointer = useRef<number | null>(null);

  const press = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pointer.current !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = event.pointerId;
    setDown(true);
    input.press(button.action);
  };

  const lift = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    setDown(false);
    input.release(button.action);
  };

  // A control that disappears mid-press -- `PULL` when the hook releases -- has to let go
  // of its bit on the way out, or the action stays held for the rest of the run.
  useEffect(() => () => {
    if (pointer.current !== null) input.release(button.action);
  }, [button.action, input]);

  return (
    <button
      type="button"
      className={`touch-button touch-${button.id} ${down ? 'is-down' : ''}`}
      aria-label={button.description}
      aria-pressed={down}
      onPointerDown={press}
      onPointerUp={lift}
      onPointerCancel={lift}
    >{button.label}</button>
  );
}
