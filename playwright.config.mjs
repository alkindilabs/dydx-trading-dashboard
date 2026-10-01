import { defineConfig, devices } from '@playwright/test';

const DEFAULT_E2E_PORT = 8123;
const E2E_PORT = Number(process.env.E2E_PORT || DEFAULT_E2E_PORT);
const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.mjs$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `python3 test/static-server.py ${E2E_PORT}`,
    url: E2E_ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
