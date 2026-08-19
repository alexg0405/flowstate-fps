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

async function openPresentation(page: Page, scene: 'start' | 'hunters', quality: 'low' | 'high'): Promise<void> {
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
  await page.goto(`/?mode=game&visualRegression=1${scene === 'hunters' ? '&scene=hunters' : ''}`);
  await Promise.all([textureReady, weaponReady]);
  await expect(page.getByRole('button', { name: /enter run/i })).toBeVisible({ timeout: 20_000 });
  await page.addStyleTag({ content: '.game-shell > :not(.game-canvas) { display: none !important; }' });
  await page.waitForTimeout(150);
}
