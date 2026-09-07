import { defineConfig } from '@playwright/test'
import { at, FIXTURE_PORT, WEB_PORT } from './e2e/lib/sizes'

/* Every screen at three sizes against the fixture daemon (ADR-0024 §6).
 *
 * Snapshots are rendered by one Chromium on one set of fonts: the Playwright
 * image CI's e2e jobs run in (web.yml). A baseline made on a developer's box
 * differs by a few pixels of text, so regenerate them inside that image, run
 * from `web/`:
 *
 *   podman run --rm -v "$PWD/..:/work" \
 *     -v "$(readlink -f node_modules):$(readlink -f node_modules)" \
 *     -w /work/web mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --update-snapshots
 *
 * In a git worktree, `node_modules` is a symlink to the main checkout's, and
 * the container cannot resolve a symlink target it has no mount for — `npx`
 * then installs its own Playwright instead of failing, and the real error is
 * a misleading "Cannot find package '@playwright/test'". The second mount
 * fixes that and is a harmless no-op in the main checkout, where
 * `node_modules` resolves to itself.
 *
 * The path template carries no platform on purpose: there is one.
 *
 * `E2E_DEV=1` runs `vite` instead of a build and `vite preview`, for a spec
 * being written against a page that is still changing. */
const CI = !!process.env.CI
const DEV = !!process.env.E2E_DEV
const web = `http://127.0.0.1:${WEB_PORT}`

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/test-results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI
    ? [['list'], ['html', { outputFolder: 'e2e/report', open: 'never' }]]
    : [['html', { outputFolder: 'e2e/report', open: 'on-failure' }]],

  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',

  expect: {
    // The fixture is one Node process for every worker on three projects, and
    // a read behind six of them takes longer than the 5 s default.
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
    },
  },

  use: {
    baseURL: web,
    trace: 'on-first-retry',
    reducedMotion: 'reduce',
    colorScheme: 'light',
    timezoneId: 'UTC',
    locale: 'en-US',
  },

  projects: [
    { name: 'phone', use: at('phone') },
    { name: 'tablet', use: at('tablet') },
    { name: 'desktop', use: at('desktop') },
  ],

  webServer: [
    {
      command: 'node --disable-warning=ExperimentalWarning e2e/fixture/server.mjs',
      url: `http://127.0.0.1:${FIXTURE_PORT}/healthz`,
      env: { FIXTURE_PORT: String(FIXTURE_PORT) },
      reuseExistingServer: !CI,
    },
    {
      // What ships, not the dev server: `vite preview` proxies `/api` and the
      // terminal upgrade to the fixture through vite.config.ts's own entry.
      command: DEV
        ? `npx vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`
        : `npx vite build && npx vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: web,
      env: { YANTRA_API: `http://127.0.0.1:${FIXTURE_PORT}` },
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
})
