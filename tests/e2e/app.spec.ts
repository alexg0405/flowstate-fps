import { type Page } from '@playwright/test';
import { expect, test } from './test';

test('opens the menu and gameplay editor', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /flow state/i })).toBeVisible();
  await page.getByRole('button', { name: /open gameplay editor/i }).click();
  await expect(page.getByText('Gameplay editor')).toBeVisible();
  await expect(page.getByRole('button', { name: /play from here/i })).toBeVisible();
});

test('loads the game runtime shell', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/wasd move/i)).toBeVisible();
});

/**
 * Headless Chromium reports `prefers-reduced-motion: reduce` by default, and the
 * save seeds itself from that media query -- which is why every other test in this
 * file runs with the transition switched off entirely, and why none of them had to
 * change for it. This block asks for the motion on purpose.
 */
test.describe('with motion enabled', () => {
  test('wipes between screens without swallowing the click that follows', async ({ page }) => {
    // Before `goto`: the save seeds `reducedMotion` from this query on first load.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    // Watched from inside the page rather than polled from outside it. Mounting the
    // next screen blocks the main thread, so an external poll can only run once the
    // wipe has already taken itself down -- it would report "never appeared".
    await page.evaluate(() => {
      const seen: { pointerEvents: string; display: string; mark: string }[] = [];
      Object.assign(window, { __wipeSightings: seen });
      new MutationObserver(() => {
        const element = document.querySelector('.screen-wipe');
        if (!element) return;
        const style = getComputedStyle(element);
        seen.push({ pointerEvents: style.pointerEvents, display: style.display, mark: element.querySelector('.wipe-mark')?.textContent ?? '' });
      }).observe(document.body, { childList: true, subtree: true });
    });

    await page.getByRole('button', { name: /open gun builder/i }).click();
    // The screen behind it mounted; nothing waited on the transition.
    await expect(page.getByRole('heading', { level: 2 })).toBeVisible();

    const sightings = await page.evaluate(() => (window as unknown as { __wipeSightings: { pointerEvents: string; display: string; mark: string }[] }).__wipeSightings);
    expect(sightings.length).toBeGreaterThan(0);
    // Transparent to input for its whole life: an overlay that took pointer events
    // for half a second would make every screen-to-screen step in this file racy.
    expect(sightings.every((sighting) => sighting.pointerEvents === 'none')).toBe(true);
    expect(sightings[0].display).not.toBe('none');
    expect(sightings[0].mark).toBe('FLOW/STATE');
    // And it takes itself back down rather than parking across the frame.
    await expect(page.locator('.screen-wipe')).toHaveCount(0, { timeout: 5_000 });

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: /flow state/i })).toBeVisible();
  });

  test('leaves the transition out when the player has asked for reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await page.evaluate(() => {
      const save = JSON.parse(localStorage.getItem('flowstate-fps-save-v1') ?? '{}');
      save.settings = { ...save.settings, reducedMotion: true };
      localStorage.setItem('flowstate-fps-save-v1', JSON.stringify(save));
    });
    await page.reload();
    await page.getByRole('button', { name: /open gun builder/i }).click();
    await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
    // The save toggle, not only the media query: the element is never rendered.
    await expect(page.locator('.screen-wipe')).toHaveCount(0);
  });
});

test('bakes editor navigation data in a worker', async ({ page }) => {
  await page.goto('/?mode=editor');
  await page.getByRole('button', { name: /bake navmesh/i }).click();
  await expect(page.getByText(/navmesh baked/i)).toBeVisible({ timeout: 20_000 });
});

test('persists camera accessibility settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByText(/camera & accessibility/i).click();
  await page.getByLabel('Field of view').fill('104');
  await page.getByRole('button', { name: /reduced motion preset/i }).click();
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('flowstate-fps-save-v1') ?? '{}').settings);
  expect(settings).toMatchObject({ fov: 104, headBob: 0, cameraRoll: 0, shake: 0 });
});

test('creates gameplay records in the editor', async ({ page }) => {
  await page.goto('/?mode=editor');
  await page.getByRole('button', { name: 'Encounter', exact: true }).click();
  await expect(page.getByText('New arena', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'AI link', exact: true }).click();
  await expect(page.getByText('Bidirectional', { exact: true })).toBeVisible();
});

test('shows grapple guidance, reduced motion, and responsive editorial UI', async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 720 });
  await page.goto('/');
  await expect(page.getByText(/grapple lines/i)).toBeVisible();
  await page.getByRole('button', { name: /start run/i }).click();
  await expect(page.getByText(/F\s*HOOK/i)).toBeVisible({ timeout: 15_000 });
  await page.getByText(/camera & accessibility/i).click();
  await page.getByLabel('Reduced motion').check();
  const reducedMotion = await page.evaluate(() => JSON.parse(localStorage.getItem('flowstate-fps-save-v1') ?? '{}').settings?.reducedMotion);
  expect(reducedMotion).toBe(true);
});

test('falls back to embedded-preview controls when pointer lock is rejected', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock unavailable in embedded preview.'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByRole('button', { name: /debug/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect(page.getByText(/runtime fault/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  // The runtime needs a few rendered frames before the fixed step accumulates,
  // so poll the telemetry instead of sampling it after a fixed delay.
  await expect.poll(async () => {
    const debug = await page.locator('.debug-panel').innerText();
    return Number(debug.match(/speed\s+([\d.]+)/)?.[1] ?? 0);
  }, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible();
});

test('shows a recoverable fault instead of a blank page when WebGL is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
      if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') return null;
      return original.call(this, contextId as '2d', ...args as []) as RenderingContext | null;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await expect(page.getByText(/runtime fault/i)).toBeVisible();
  await page.getByRole('button', { name: /return to menu/i }).click();
  await expect(page.getByRole('heading', { name: /flow state/i })).toBeVisible();
});

test('drives the active HUD while input is captured', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock unavailable in embedded preview.'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByRole('button', { name: /debug/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden();

  const hud = page.locator('.hud');
  await expect(hud).toBeVisible();
  // The reduced HUD: a reticle cluster, two corners, one top bar. Speed left the
  // HUD entirely, so the live telemetry is read from the debug channel.
  await expect(page.getByLabel(/^grapple (armed|tethered|relink)$/i)).toBeVisible();
  await expect(page.locator('.flow-cluster .combo-multiplier')).toBeVisible();
  await expect(page.locator('.hud-ammo .ammo-value')).toContainText('30', { timeout: 20_000 });
  await expect(page.locator('.hud-health .health-value')).toContainText('100');

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  await expect.poll(async () => {
    const debug = await page.locator('.debug-panel').innerText();
    return Number(debug.match(/speed\s+([\d.]+)/)?.[1] ?? 0);
  }, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));
  await expect(page.locator('.hud-objective')).toContainText(/clear|finish/i);
});

test('keeps Enter run reachable without scrolling on a 720p viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?mode=game');
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible({ timeout: 20_000 });

  const fit = await page.evaluate(() => {
    const card = document.querySelector('.start-card')!;
    const enter = document.querySelector('.enter-action')!.getBoundingClientRect();
    return {
      overflow: card.scrollHeight - card.clientHeight,
      // How much taller the card could grow before it started clipping again. Once
      // the content fits, `scrollHeight` equals `clientHeight`, so the slack has to
      // come from the cap the card is allowed to reach.
      headroom: Math.round(parseFloat(getComputedStyle(card).maxHeight) - card.scrollHeight),
      enterBottom: enter.bottom,
      contentBottom: card.getBoundingClientRect().top + card.clientHeight,
      viewportHeight: window.innerHeight,
    };
  });

  // This card is also the pause screen, and this button is how a run resumes. The
  // card scrolls, so a `toBeVisible` assertion is not enough on its own -- an
  // overflowing card clips the button while still reporting it visible.
  expect(fit.overflow).toBe(0);
  expect(fit.enterBottom).toBeLessThanOrEqual(fit.contentBottom);
  expect(fit.enterBottom).toBeLessThanOrEqual(fit.viewportHeight);
  // The day's contract sets the tallest block on this card and its copy is not
  // fixed-length, so leave slack for a longer one than today's rather than passing
  // by a pixel on the calendar's say-so.
  expect(fit.headroom).toBeGreaterThan(30);
});

test('presents the completion panel and records the run', async ({ page }) => {
  await page.goto('/?mode=game&scene=finish');
  await expect(page.getByRole('heading', { name: /run complete/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.completion-summary')).toContainText('points');
  await expect(page.locator('.completion-grid')).toContainText('White Line');
  // The graded run is now shown, not just persisted: rank, and the record flags the
  // previous implementation computed and discarded.
  await expect(page.locator('.grade-letter')).toHaveText(/^[SABC]$/);
  await expect(page.locator('.grade-delta')).toContainText(/first clear|vs best/i);
  const save = await page.evaluate(() => JSON.parse(localStorage.getItem('flowstate-fps-save-v1') ?? '{}'));
  expect(save.schemaVersion).toBe(4);
  // One coherent record rather than three fields from three different attempts.
  expect(save.bestRun).toMatchObject({ rank: expect.stringMatching(/^[SABC]$/) });
  expect(save.bestRun.timeSeconds).toEqual(expect.any(Number));
  await page.getByRole('button', { name: /return to menu/i }).click();
  await expect(page.getByRole('heading', { name: /flow state/i })).toBeVisible();
});

test('collapses the editor inspector into a drawer on narrow viewports', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 760 });
  await page.goto('/?mode=editor');
  const statusBar = page.getByLabel('Editor status');
  await expect(statusBar).toContainText('Validation');
  await expect(statusBar).toContainText('clean');

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toBeHidden();
  const toggle = page.getByRole('button', { name: /^inspector$/i });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(inspector).toBeVisible();
  await page.getByRole('button', { name: /hide inspector/i }).click();
  await expect(inspector).toBeHidden();
});

test('groups the editor palette and filters the scene hierarchy', async ({ page }) => {
  await page.goto('/?mode=editor');
  await expect(page.getByRole('group', { name: 'History' })).toBeVisible();
  await expect(page.getByText('Geometry', { exact: true })).toBeVisible();
  await expect(page.getByText('Lighting', { exact: true })).toBeVisible();

  const hierarchy = page.getByLabel('Scene hierarchy');
  await expect(hierarchy.getByRole('button', { name: 'start-floor', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Lights' }).click();
  await expect(hierarchy.getByRole('button', { name: 'start-floor', exact: true })).toBeHidden();
  await expect(hierarchy.getByRole('button', { name: 'light-start-cyan', exact: true })).toBeVisible();
});

test('resolves a double-tapped jump into a dash in the live runtime', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock unavailable in embedded preview.'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByRole('button', { name: /debug/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden();

  // Let the capsule settle so the first tap is a grounded jump.
  await expect.poll(async () => (await page.locator('.debug-panel').innerText()).includes('state      grounded'), { timeout: 30_000 }).toBe(true);

  await page.evaluate(() => {
    const press = (code: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    };
    press('Space');
    setTimeout(() => press('Space'), 60);
  });

  // The dash state itself only lasts ~160 ms, so assert its durable effect:
  // no other input can push the player past sprint speed.
  await expect.poll(async () => {
    const debug = await page.locator('.debug-panel').innerText();
    return Number(debug.match(/speed\s+([\d.]+)/)?.[1] ?? 0);
  }, { timeout: 20_000 }).toBeGreaterThan(15);
  await expect(page.locator('.flow-cluster .combo-multiplier')).toBeVisible();
});

test('slashes on the left mouse button in the live runtime', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock unavailable in embedded preview.'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByRole('button', { name: /debug/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden();
  await expect.poll(async () => (await page.locator('.debug-panel').innerText()).includes('state      grounded'), { timeout: 30_000 }).toBe(true);

  // The blade is on the left button now, and it is held rather than clicked, so the
  // action has to enter and stay in `melee` for as long as the button is down.
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown', { button: 0 })));
  await expect.poll(async () => (await page.locator('.debug-panel').innerText()).includes('/ melee'), { timeout: 20_000 }).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 0 })));

  // And the sidearm is on the right button, which is what still spends a round.
  const ammo = page.locator('.hud-ammo .ammo-value strong');
  await expect(ammo).toHaveText('30', { timeout: 20_000 });
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown', { button: 2 })));
  await expect.poll(async () => Number(await ammo.innerText()), { timeout: 20_000 }).toBeLessThan(30);
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 2 })));
});

/** Total seconds the presentation clock has spent frozen, off the debug channel. */
async function hitstopTotalSeconds(page: Page): Promise<number> {
  const panel = await page.locator('.debug-panel').innerText();
  return Number(panel.match(/hitstop\s+.*?\/\s*([\d.]+) s total/)?.[1] ?? -1);
}

/**
 * Walks the route into the first arena and fights until a hostile goes down.
 *
 * The spin is not decoration. The brawler closes to inside the blade and then circles:
 * measured, it sits 2.4 m away at a bearing of 135 degrees, which is behind the
 * player's shoulder. A player turns to face it; a test has to say so, and dispatching
 * `movementX` is how look input reaches `InputController` outside pointer lock.
 */
async function fightIntoTheAtrium(page: Page): Promise<void> {
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByRole('button', { name: /debug/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden();
  await expect.poll(async () => (await page.locator('.debug-panel').innerText()).includes('state      grounded'), { timeout: 30_000 }).toBe(true);

  // Straight forward, no jumping: the route rises on a ramp and drops onto the arena
  // deck, and a jump only throws the player off it.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  await expect.poll(async () => {
    const z = Number((await page.locator('.debug-panel').innerText()).match(/position\s+\S+ \S+ (\S+)/)?.[1] ?? 0);
    return z;
  }, { timeout: 60_000 }).toBeLessThan(-40);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
  });

  const hostiles = async (): Promise<number> => Number(await page.locator('.objective-count').innerText().catch(() => '0'));
  for (let sweep = 0; sweep < 24 && (await hostiles()) > 1; sweep += 1) {
    await page.evaluate(() => {
      for (let step = 0; step < 8; step += 1) window.dispatchEvent(new MouseEvent('mousemove', { movementX: 40 }));
    });
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 0 })));
  expect(await hostiles()).toBeLessThan(2);
}

test('freezes the frame on a landed blow', async ({ page }) => {
  // Walking the route and fighting through an arena is the slowest thing this suite
  // does, and `test.slow()` triples the default to ninety seconds, which is not enough.
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock unavailable in embedded preview.'));
  });
  // Stated rather than assumed. AUDIT.md section 13 records that headless Chromium
  // reported `prefers-reduced-motion: reduce` and that the save was seeded from it, so
  // no test saw any motion. Measured on this Playwright build, both Chromium and
  // Firefox now report `no-preference`, so the default has flipped -- which makes it
  // worth asking for explicitly at both ends rather than inheriting whatever the
  // pinned browser happens to say this month.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await fightIntoTheAtrium(page);
  // The running total, not the instantaneous figure: a freeze is three to six frames
  // wide and the telemetry refreshes at 20 Hz, so sampling the live value from outside
  // the page lands between freezes almost every time.
  expect(await hitstopTotalSeconds(page)).toBeGreaterThan(0);
});

test('never freezes the frame with reduced motion on', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock unavailable in embedded preview.'));
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await fightIntoTheAtrium(page);
  // The same fight, the same kills, and the frame never stopped once. Hitstop is a
  // save-file toggle as well as a media query, and this suite reports `reduce`.
  expect(await hitstopTotalSeconds(page)).toBe(0);
});

test('turns a telegraphed shot into a perfect dodge', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock unavailable in embedded preview.'));
    // The confirmation is a 620 ms transient that unmounts on its own clock, so polling
    // for the element races it: it can appear and go between two queries, or expire
    // between the poll that saw it and the assertion that checks it. An observer
    // records that it happened, which is the fact under test.
    const record = { seen: '' };
    (window as unknown as { __dodge: typeof record }).__dodge = record;
    new MutationObserver(() => {
      const mark = document.querySelector('.perfect-dodge');
      if (mark) record.seen = mark.textContent ?? '';
    }).observe(document, { childList: true, subtree: true });
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByRole('button', { name: /debug/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden();
  await expect.poll(async () => (await page.locator('.debug-panel').innerText()).includes('state      grounded'), { timeout: 30_000 }).toBe(true);
  await expect(page.locator('.debug-panel')).toContainText('dodge      ready');

  // Into the atrium, where a hunter holds distance and telegraphs every shot.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  await expect.poll(
    async () => Number((await page.locator('.debug-panel').innerText()).match(/position\s+\S+ \S+ (\S+)/)?.[1] ?? 0),
    { timeout: 60_000 },
  ).toBeLessThan(-42);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));

  // Dash has no key of its own -- the simulation reads it off a double-tapped jump --
  // so keep double-tapping through the incoming fire. The frames are rationed to about
  // 29 per cent uptime, so this is several shots' worth of attempts, not one.
  const seen = async (): Promise<string> => page.evaluate(() => (window as unknown as { __dodge: { seen: string } }).__dodge.seen);
  for (let attempt = 0; attempt < 60 && !(await seen()); attempt += 1) {
    // Dying is part of standing in an arena trading with a hunter, and the checkpoint is
    // back at the spawn -- so a run that goes down has to redeploy and walk in again,
    // or the rest of the loop double-taps at nothing fifty metres away. That is what
    // made this flake once in a full-suite run while passing on its own.
    if (await page.locator('.down-panel').count()) {
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      });
      await expect.poll(
        async () => Number((await page.locator('.debug-panel').innerText()).match(/position\s+\S+ \S+ (\S+)/)?.[1] ?? 0),
        { timeout: 60_000 },
      ).toBeLessThan(-42);
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));
      continue;
    }
    // Dash sideways, alternating, so the player works the middle of the arena instead
    // of piling into the gate at the far end.
    await page.evaluate((strafe) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: strafe }));
      const tap = () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
      };
      tap();
      setTimeout(tap, 70);
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: strafe })), 240);
    }, attempt % 8 < 4 ? 'KeyD' : 'KeyA');
    await page.waitForTimeout(220);
  }
  expect(await seen()).toContain('PERFECT');
});

test('builds and drives the audio graph in a real browser without faulting', async ({ page }) => {
  test.setTimeout(180_000);
  // The whole mix is synthesised and every optional node is feature-detected, which is
  // what lets it run against a test double with no Web Audio at all. The cost of that
  // is that a wrong node name, a bad parameter or an unsupported buffer shape fails
  // silently in jsdom and only ever surfaces in a browser -- so this drives the real
  // graph through real combat and insists nothing throws.
  const faults: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') faults.push(message.text());
  });
  page.on('pageerror', (error) => faults.push(error.message));

  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock unavailable in embedded preview.'));
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByRole('button', { name: /debug/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect.poll(async () => (await page.locator('.debug-panel').innerText()).includes('state      grounded'), { timeout: 30_000 }).toBe(true);

  // Stated, because the mix silently degrades to dry and unlimited without them.
  expect(await page.evaluate(() => {
    const context = new AudioContext();
    const support = {
      convolver: typeof context.createConvolver === 'function',
      compressor: typeof context.createDynamicsCompressor === 'function',
      panner: typeof context.createStereoPanner === 'function',
    };
    void context.close();
    return support;
  })).toEqual({ convolver: true, compressor: true, panner: true });

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  await expect.poll(
    async () => Number((await page.locator('.debug-panel').innerText()).match(/position\s+\S+ \S+ (\S+)/)?.[1] ?? 0),
    { timeout: 60_000 },
  ).toBeLessThan(-42);
  // Blade and sidearm together, turning through incoming fire: shots, impacts, hits,
  // telegraphs, kills, damage taken and the ducks over the top of all of it.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
  });
  for (let sweep = 0; sweep < 16; sweep += 1) {
    await page.evaluate(() => {
      for (let step = 0; step < 4; step += 1) window.dispatchEvent(new MouseEvent('mousemove', { movementX: 40 }));
    });
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
  });
  expect(faults).toEqual([]);
});

test('builds a weapon in the armory and carries it into a run', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await page.getByRole('button', { name: /open gun builder/i }).click();
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();

  await page.getByLabel('Build name').fill('Breacher');
  await page.getByRole('tab', { name: 'Shotgun' }).click();
  // The bench fits parts by opening the slot and choosing a card, not by picking an
  // option out of a dropdown.
  await page.locator('.slot-tile', { hasText: 'Magazine' }).first().click();
  await page.locator('.part-card', { hasText: 'Extended magazine' }).click();
  await expect(page.locator('.part-card.is-fitted')).toContainText('Extended magazine');
  await page.getByRole('button', { name: 'Carry as 1' }).click();

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('flowstate-fps-save-v1') ?? '{}'));
  expect(saved.schemaVersion).toBe(4);
  const carried = saved.armory.find((build: { id: string }) => build.id === saved.loadout[0]);
  expect(carried).toMatchObject({ name: 'Breacher', chassisId: 'shotgun' });
  expect(carried.parts.magazine).toBe('magazine.extended');

  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: /start run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible({ timeout: 20_000 });
  // 6 base shells with an extended magazine resolves to 9.
  // Uppercasing is a CSS transform, so match the underlying text.
  await expect(page.getByRole('group', { name: /carried weapons/i })).toContainText(/breacher/i);
  await expect(page.locator('.hud-ammo .ammo-value')).toContainText('9', { timeout: 20_000 });
});

test('swaps between the two carried weapons in the live runtime', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock unavailable in embedded preview.'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden();

  const weapon = page.locator('.hud-ammo .ammo-weapon');
  await expect(weapon).toContainText(/carbine/i, { timeout: 20_000 });

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' })));
  await expect(weapon).toContainText(/smg/i, { timeout: 20_000 });
  await expect(page.locator('.hud-ammo .ammo-value')).toContainText('40');
});

test('opens the gun builder from the pause overlay', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await page.getByRole('button', { name: /gun builder/i }).click({ timeout: 20_000 });
  await expect(page.getByText(/next checkpoint respawn/i)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible();
});
