import { useEffect, useRef, type CSSProperties } from 'react';
import { presentation } from '../content/config';

/**
 * A sheared band carrying the wordmark across the frame between screens.
 *
 * Three constraints shaped this, and all of them are load bearing:
 *
 * - **It must not gate the screen behind it.** `GameScreen` builds WebGL and Rapier
 *   on mount; delaying that mount to play a transition would either stall the run or
 *   double-mount the renderer. So the new screen mounts immediately and the wipe
 *   passes over the top of it. Nothing waits on this component.
 * - **It must not swallow a click.** The e2e suite steps straight from one screen to
 *   the next, and an overlay that intercepted pointer events for half a second would
 *   make ten tests flaky. The layer is `pointer-events: none` throughout.
 * - **It must remove itself without a timer racing React.** `animationend` is the
 *   real signal. The timeout below is only a floor, for the case where the tab is
 *   backgrounded mid-transition and served no animation frames at all -- without it
 *   the band would still be parked across the frame when the player came back.
 */
export function ScreenWipe({ onDone }: { onDone: () => void }) {
  const band = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = band.current;
    // A native listener rather than React's `onAnimationEnd`: the synthetic event
    // does not fire for a dispatched `animationend` under jsdom, which would leave
    // the removal path untested. The native one behaves identically in a browser.
    const finish = (event: Event) => { if (event.target === element) onDone(); };
    element?.addEventListener('animationend', finish);
    const floor = window.setTimeout(onDone, presentation.wipeSeconds * 1000 + 250);
    return () => {
      element?.removeEventListener('animationend', finish);
      window.clearTimeout(floor);
    };
  }, [onDone]);

  return (
    <div
      ref={band}
      className="screen-wipe"
      aria-hidden="true"
      style={{ '--wipe': `${presentation.wipeSeconds}s` } as CSSProperties}
    >
      <i className="wipe-fill" />
      <i className="wipe-lead" />
      <span className="wipe-mark display-cut">FLOW<em>/</em>STATE</span>
    </div>
  );
}
