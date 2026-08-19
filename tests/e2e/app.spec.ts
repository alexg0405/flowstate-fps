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
  await page.getByRole('button', { name: /run white line/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/wasd move/i)).toBeVisible();
});

test('bakes editor navigation data in a worker', async ({ page }) => {
  await page.goto('/?mode=editor');
  await page.getByRole('button', { name: /bake navmesh/i }).click();
  await expect(page.getByText(/navmesh baked/i)).toBeVisible({ timeout: 20_000 });
});

test('persists camera accessibility settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /run white line/i }).click();
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
  await expect(page.getByText(/cast the line/i)).toBeVisible();
  await page.getByRole('button', { name: /run white line/i }).click();
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
  await page.getByRole('button', { name: /run white line/i }).click();
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
  await page.getByRole('button', { name: /run white line/i }).click();
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
  await page.getByRole('button', { name: /run white line/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden();

  const hud = page.locator('.hud');
  await expect(hud).toBeVisible();
  await expect(page.getByLabel(/^grapple (armed|tethered|relink)$/i)).toBeVisible();
  await expect(page.getByRole('group', { name: /movement chain availability/i })).toBeVisible();
  await expect(page.locator('.hud-ammo .ammo-value')).toContainText('30', { timeout: 20_000 });

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  await expect(page.locator('.speed-readout strong')).not.toHaveText('0.0', { timeout: 20_000 });
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));
  await expect(page.locator('.hud-objective')).toContainText(/clear|finish/i);
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
  await page.getByRole('button', { name: /run white line/i }).click();
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
  await expect(page.getByRole('group', { name: /movement chain availability/i })).toContainText('WALL');
});

test('builds a weapon in the armory and carries it into a run', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await page.getByRole('button', { name: /open gun builder/i }).click();
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();

  await page.getByLabel('Build name').fill('Breacher');
  await page.getByRole('tab', { name: 'Shotgun' }).click();
  await page.getByLabel('Magazine').selectOption('magazine.extended');
  await page.getByRole('button', { name: 'Carry as 1' }).click();

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('flowstate-fps-save-v1') ?? '{}'));
  expect(saved.schemaVersion).toBe(4);
  const carried = saved.armory.find((build: { id: string }) => build.id === saved.loadout[0]);
  expect(carried).toMatchObject({ name: 'Breacher', chassisId: 'shotgun' });
  expect(carried.parts.magazine).toBe('magazine.extended');

  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: /run white line/i }).click();
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
  await page.getByRole('button', { name: /run white line/i }).click();
  await page.getByRole('button', { name: /enter run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden();

  const strip = page.getByRole('group', { name: /carried weapons/i });
  await expect(strip.locator('span').first()).toHaveClass(/is-active/, { timeout: 20_000 });

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' })));
  await expect(strip.locator('span').nth(1)).toHaveClass(/is-active/, { timeout: 20_000 });
  await expect(page.locator('.hud-ammo .ammo-value')).toContainText('40');
});

test('opens the gun builder from the pause overlay', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /run white line/i }).click();
  await page.getByRole('button', { name: /gun builder/i }).click({ timeout: 20_000 });
  await expect(page.getByText(/next checkpoint respawn/i)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible();
});
