import { expect, test as base, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const processEnvironment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
const useStaticDist = processEnvironment?.FLOWSTATE_STATIC_DIST === '1';
const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const origin = 'http://127.0.0.1:4173';

export const test = base.extend({
  page: async ({ page }, use) => {
    if (useStaticDist) await installStaticDist(page);
    await use(page);
  },
});

export { expect };

async function installStaticDist(page: Page): Promise<void> {
  await page.route(`${origin}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    const filePath = path.resolve(distRoot, `.${pathname}`);
    if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${path.sep}`)) {
      await route.fulfill({ status: 403, body: 'Forbidden' });
      return;
    }
    try {
      const body = await readFile(filePath);
      await route.fulfill({ status: 200, body, contentType: contentType(filePath) });
    } catch {
      await route.fulfill({ status: 404, body: 'Not found' });
    }
  });
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.glb': 'model/gltf-binary',
    '.ktx2': 'image/ktx2',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  }[extension] ?? 'application/octet-stream';
}
