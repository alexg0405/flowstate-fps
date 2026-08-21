import { useEffect, useState } from 'react';

/**
 * Whether the frame is wider than it is tall.
 *
 * Read from a media query rather than from `screen.orientation`, which reports the
 * device and not the window: an app in a split view or a preview pane can be portrait on
 * a landscape phone, and it is the *frame* the route has to fit into.
 */
const LANDSCAPE = '(orientation: landscape)';

export function useLandscape(): boolean {
  const [landscape, setLandscape] = useState(matchesLandscape);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(LANDSCAPE);
    const listener = () => setLandscape(query.matches);
    query.addEventListener('change', listener);
    listener();
    return () => query.removeEventListener('change', listener);
  }, []);
  return landscape;
}

function matchesLandscape(): boolean {
  // Anything without media queries -- jsdom, and the tests that run in it -- is treated
  // as landscape, because the alternative is every interface test rendering a notice
  // telling a headless browser to turn itself round.
  if (typeof matchMedia !== 'function') return true;
  return matchMedia(LANDSCAPE).matches;
}
