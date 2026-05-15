// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright configuration optimized for CI smoke tests.
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './tests/smoke',

  // Each test can run for a max of 30 seconds
  timeout: 30 * 1000,

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if tests were accidentally left in exclusive mode
  forbidOnly: !!process.env.CI,

  // No retries - smoke tests should be stable, failures indicate real problems
  retries: 0,

  // Single worker in CI to avoid resource contention
  workers: process.env.CI ? 1 : undefined,

  // Reporter config
  reporter: process.env.CI
    ? [['list'], ['github']]  // CI: console + GitHub annotations
    : [['list']],             // Local: console only

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    actionTimeout: 10 * 1000,
  },

  // Web server configuration - wait for the container/server to be ready
  webServer: process.env.CI ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },

  // Test projects - Chromium only for fast CI smoke tests
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
