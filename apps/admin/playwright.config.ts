import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run the real stack: PostgreSQL 18 (Testcontainers) → API (port 3101) →
 * built admin app served by `vite preview` (port 4174). See e2e/global-setup.ts.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
