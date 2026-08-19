import { defineConfig, devices } from '@playwright/test';

const processEnvironment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
const useStaticDist = processEnvironment?.FLOWSTATE_STATIC_DIST === '1';

export default defineConfig({
  testDir: './tests/e2e',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: useStaticDist ? undefined : { command: 'npm run build && npm run preview -- --host 127.0.0.1', port: 4173, reuseExistingServer: false },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
