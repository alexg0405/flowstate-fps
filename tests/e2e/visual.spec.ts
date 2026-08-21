import type { Page } from '@playwright/test';
import { expect, test } from './test';

test.describe('deterministic cyber-dusk presentation', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Pixel baselines use the pinned Chromium renderer.');

  test('high-quality White Line and VX-09', async ({ page }) => {
    await openPresentation(page, 'start', 'high');
    await expect(page).toHaveScreenshot('white-line-vx09-high.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.035,
      timeout: 20_000,
    });
  });

  test('high-quality corporate hunter pair', async ({ page }) => {
    await openPresentation(page, 'hunters', 'high');
    await expect(page).toHaveScreenshot('corporate-hunters-high.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.035,
      timeout: 20_000,
    });
  });

  test('low-quality production presentation', async ({ page }) => {
    await openPresentation(page, 'start', 'low');
    await expect(page).toHaveScreenshot('white-line-vx09-low.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.035,
      timeout: 20_000,
    });
  });
});

/**
 * The composition baselines.
 *
 * These exist because of a hard constraint rather than a preference: the agent working on
 * this route cannot render it. WebGL2 contexts are lost the moment they are created in its
 * environment -- `getContext` succeeds, `isContextLost()` is already true and `getError()`
 * returns `CONTEXT_LOST_WEBGL` -- on unmodified `main` as well, so it is not a regression.
 * The Chrome extension that would hand it a real GPU is blocked by org policy.
 *
 * What is left is this: one command on a machine with a GPU regenerates these PNGs, and
 * the PNGs are files on disk that can be read and measured. `tests/compositionPreview.
 * test.ts` projects silhouettes without a GPU and is good for scale and placement; this is
 * what settles value, colour and everything the projection admits it leaves out.
 *
 *     npm run test:e2e -- --project=chromium --update-snapshots tests/e2e/visual.spec.ts
 *
 * The four cones are the ones `vistaCones` authors, at the pitch each is composed for --
 * except that pitch cannot be set from a spawn, so these are level-camera views of the
 * same positions. Read them for value hierarchy and colour, not for framing.
 */
test.describe('composition baselines', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Pixel baselines use the pinned Chromium renderer.');

  for (const cone of ['slot', 'reveal', 'street', 'overlook'] as const) {
    test(`vista blockout: ${cone}`, async ({ page }) => {
      await openScene(page, `&scene=vista&vista=${cone}`, 'high');
      await expect(page).toHaveScreenshot(`vista-${cone}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.035,
        timeout: 20_000,
      });
    });
  }

  test('white line: the bridge reveal', async ({ page }) => {
    await openScene(page, '', 'high');
    await expect(page).toHaveScreenshot('white-line-canyon.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.035,
      timeout: 20_000,
    });
  });
});

async function openPresentation(page: Page, scene: 'start' | 'hunters', quality: 'low' | 'high'): Promise<void> {
  await openScene(page, scene === 'hunters' ? '&scene=hunters' : '', quality);
}

/** The staging `openPresentation` was, with the scene left as a query string. */
async function openScene(page: Page, query: string, quality: 'low' | 'high'): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript((graphicsQuality) => {
    localStorage.setItem('flowstate-fps-save-v1', JSON.stringify({
      schemaVersion: 2,
      settings: { graphicsQuality, dynamicResolution: false, reducedMotion: true, renderScale: 1 },
      bestTimeSeconds: null,
      bestScore: 0,
      rank: null,
    }));
  }, quality);

  const textureReady = page.waitForResponse((response) => response.url().endsWith('/signal-circuit.ktx2') && response.ok());
  const weaponReady = page.waitForResponse((response) => response.url().endsWith('/runner-rifle.glb') && response.ok());
  await page.goto(`/?mode=game&visualRegression=1${query}`);
  await Promise.all([textureReady, weaponReady]);
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible({ timeout: 20_000 });
  await page.addStyleTag({ content: '.game-shell > :not(.game-canvas) { display: none !important; }' });
  await page.waitForTimeout(150);
}
