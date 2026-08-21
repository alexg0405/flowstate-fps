import { type Page } from '@playwright/test';
import { expect, test } from './test';

/**
 * The touch scheme, in a browser that reports itself as a touch device.
 *
 * Everything here turns on one media query: `(pointer: coarse)` decides whether the game
 * draws a thumbstick, and Playwright's `hasTouch` and `isMobile` are what make Chromium
 * answer it the way a phone does. Firefox cannot emulate a mobile device at all, so the
 * whole file is Chromium's.
 *
 * The tablet-sized viewport is deliberate rather than incidental: the play frame drops
 * the debug panel under 460 px of height, and the debug panel is how every other case in
 * this suite reads where the player is standing.
 */
const TABLET = { hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } };

const RUNTIME_READY_TIMEOUT = 45_000;
const ENTERED_RUN_TIMEOUT = 25_000;

test.describe('on a touch device', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'mobile emulation is Chromium-only');
  test.use(TABLET);

  test('draws the on-screen scheme instead of asking for a mouse', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /start run/i }).click();
    await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT });
    // The standby card says what this device actually does, rather than promising to
    // capture a mouse that does not exist.
    await expect(page.getByText(/on-screen controls/i)).toBeVisible();
    await expect(page.getByText(/left thumb/i)).toBeVisible();

    await page.getByRole('button', { name: /enter run/i }).click();
    await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden({ timeout: ENTERED_RUN_TIMEOUT });
    await expect(page.locator('.touch-controls')).toBeVisible();
    for (const control of ['Attack with the selected weapon', 'Heavy swing', 'Jump, and twice to dash', 'Cast the hook', 'Pause the run']) {
      await expect(page.getByRole('button', { name: control, exact: true })).toBeVisible();
    }
    // Contextual controls stay off the frame until they mean something.
    await expect(page.getByRole('button', { name: 'Pull along the hook' })).toHaveCount(0);
  });

  test('walks the route on the thumbstick and hands the run back on the pause control', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await page.getByRole('button', { name: /start run/i }).click();
    await page.getByRole('button', { name: /debug/i }).click();
    await page.getByRole('button', { name: /enter run/i }).click();
    await expect(page.getByRole('button', { name: /enter run/i })).toBeHidden({ timeout: ENTERED_RUN_TIMEOUT });
    await expect.poll(async () => (await page.locator('.debug-panel').innerText()).includes('state      grounded'), { timeout: ENTERED_RUN_TIMEOUT * 2 }).toBe(true);

    const before = await depth(page);
    // A thumb landing in the left half and pushing up. The stick appears where the thumb
    // lands, which is why the press point and the drag target are both arbitrary.
    await page.mouse.move(220, 600);
    await page.mouse.down();
    await page.mouse.move(220, 500, { steps: 4 });
    await expect.poll(() => depth(page), { timeout: 60_000 }).toBeLessThan(before - 6);
    await page.mouse.up();

    // And the way out, which on this device is a control rather than a key.
    await page.getByRole('button', { name: 'Pause the run' }).click();
    await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible({ timeout: ENTERED_RUN_TIMEOUT });
  });

  test('asks to be turned round in portrait', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    await page.getByRole('button', { name: /start run/i }).click();
    // The route is authored wide and read at speed; a portrait frame shows a third of it.
    await expect(page.getByRole('alert').filter({ hasText: /turn your device/i })).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT });
  });
});

test('leaves a mouse and keyboard alone', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /start run/i }).click();
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible({ timeout: RUNTIME_READY_TIMEOUT });
  // `pointer: coarse` describes the primary pointer, so a desktop keeps the scheme it
  // has -- including the promise about the mouse, which it can keep.
  await expect(page.getByText(/captures your mouse/i)).toBeVisible();
  await expect(page.getByText(/wasd move/i)).toBeVisible();
  await expect(page.locator('.touch-controls')).toHaveCount(0);
});

/** How far down the route the player has walked. Negative Z is forward. */
async function depth(page: Page): Promise<number> {
  const text = await page.locator('.debug-panel').innerText();
  return Number(text.match(/position\s+\S+ \S+ (\S+)/)?.[1] ?? 0);
}
