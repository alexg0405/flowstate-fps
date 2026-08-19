import { chromium } from '@playwright/test';
const [, , out, quality] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript((q) => localStorage.setItem('flowstate-fps-save-v1', JSON.stringify({
  schemaVersion: 4, settings: { graphicsQuality: q }, bestRun: null, bestTimeSeconds: null,
})), quality);
await page.goto('http://localhost:5178/?mode=game' + String.fromCharCode(38) + 'scene=hunters');
await page.getByRole('button', { name: /enter run/i }).click();
await page.waitForFunction(() => !document.querySelector('.game-overlay'), null, { timeout: 30000 });
await page.waitForTimeout(2400);
await page.screenshot({ path: out });
await browser.close();
console.log('captured', quality);
