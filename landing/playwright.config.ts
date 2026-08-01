import { defineConfig, devices } from '@playwright/test';

/* Visual regression for the landing page. Four snapshots: both grounds x desktop and mobile.
 *
 * Snapshots are OS-specific but Playwright's default path template no longer includes the
 * platform, so a Linux and a macOS run collide at one path while rendering fonts differently.
 * The template below is still platform-free on purpose -- these are generated and reviewed on
 * Linux only. If a second OS ever runs them, add {platform} here before trusting a diff. */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'list' : 'html',

  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
    },
  },

  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'on-first-retry',
    timezoneId: 'UTC',
    locale: 'en-US',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // SwiftShader, or the yantra island renders nothing headless and every
        // snapshot silently records an empty niche.
        launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
      },
    },
  ],

  webServer: {
    // Against the production build, not `astro dev`. The dev server injects the Astro dev
    // toolbar -- a pill of icons at the bottom centre of the viewport -- which lands in every
    // baseline and then silently masks whatever it covers. Visual regression should look at
    // what ships anyway.
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4321',
    url: 'http://127.0.0.1:4321',
    // Astro 7 bundles am-i-vibing and forks itself into the background when it detects an
    // agent environment, so the foreground process exits 0 and this block fails with
    // "exited early". The flag name reads backwards: it means "I am already the child".
    env: { ASTRO_DEV_BACKGROUND: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
