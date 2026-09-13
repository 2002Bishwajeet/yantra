import type { Page } from '@playwright/test'
import { axe, expect, scenario, screenshot, test } from './lib/test'

/* Y-396. Install from the machine page, at all three sizes, against the
   fixture's `install` scenario: pi-5 finishes, nas stops with a sudo step
   left for a person, and hetzner-1 is still running when the page is looked
   at. */

const ready = (page: Page) => page.getByRole('region', { name: 'Readiness' })

async function open(page: Page, machine: string) {
  await scenario(page, 'install')
  await page.goto(`/m/${machine}`)
  await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
}

test.describe('install from the machine page', () => {
  test('installed: runs, lands, and readiness asks again', async ({ page, size }) => {
    await open(page, 'pi-5')
    await expect(ready(page).getByRole('heading', { name: 'claude is missing' })).toBeVisible()
    const asked = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/machines/pi-5/readiness'),
    )
    await ready(page).getByRole('button', { name: 'Install' }).click()
    await expect(ready(page).getByRole('heading', { name: 'Installing claude' })).toBeVisible()
    await asked
    // pi-5 still has no gh, so the next thing is gh, and a session may start.
    await expect(ready(page).getByRole('heading', { name: 'gh is missing' })).toBeVisible({ timeout: 15_000 })
    await expect(ready(page).getByText(/^8 of 10 · asked/)).toBeVisible()
    await expect(ready(page).getByText('installed by Yantra')).toBeVisible()
    await expect(ready(page).getByRole('link', { name: 'New session' })).toBeVisible()
    await expect(page.getByText('pi-5 is ready for sessions')).toBeVisible()
    await page.getByRole('button', { name: 'Dismiss' }).click()
    await axe(page)
    await screenshot(page, 'machine-installed', 'install', size)
  })

  test('stopped: the password step is left for a person, with Copy', async ({ page, size }) => {
    await open(page, 'nas')
    await ready(page).getByRole('button', { name: 'Install' }).click()
    await expect(ready(page).getByRole('heading', { name: 'tmux and claude need your password' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(
      ready(page).getByText('sudo apt-get update; sudo apt-get install -y tmux curl', { exact: true }),
    ).toBeVisible()
    await expect(ready(page).getByRole('button', { name: 'Copy the command for nas' })).toBeVisible()
    await expect(ready(page).getByRole('button', { name: 'Install again' })).toBeVisible()
    await axe(page)
    await screenshot(page, 'machine-install-stopped', 'install', size)
  })

  /* Y-394, ADR-0030: the password step in a terminal of its own. */
  test('sudo: the step runs in a one-off terminal, and the password is only keystrokes', async ({ page, size }) => {
    await open(page, 'nas')
    await ready(page).getByRole('button', { name: 'Install' }).click()
    await ready(page).getByRole('button', { name: 'Open a terminal' }).click({ timeout: 15_000 })

    const sheet = size === 'phone' ? page.getByRole('dialog', { name: 'Run it on nas' }) : page.getByRole('complementary', { name: 'Run it on nas' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText(/Your password goes to nas as keystrokes; Yantra does not keep it./)).toBeVisible()
    await expect(sheet.locator('.xterm-rows')).toContainText('password for yantra', { timeout: 15_000 })
    await axe(page)

    await sheet.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('hunter2')
    await page.keyboard.press('Enter')

    await expect(sheet.getByText('It finished on nas. Readiness asks nas again now.')).toBeVisible({ timeout: 15_000 })
    await expect(sheet.getByRole('status').first()).toContainText('exited 0')
    await expect(sheet.locator('.xterm-rows')).not.toContainText('hunter2')
    // The step installed tmux, so claude is what is left, and Install asks for it.
    await expect(ready(page).getByRole('heading', { name: 'claude is missing' })).toBeVisible({ timeout: 15_000 })

    await sheet.getByRole('button', { name: size === 'phone' ? 'Close' : 'Close Run it on nas' }).click()
    await expect(sheet).toBeHidden()
  })

  test('running: a second press is the 409, and the page waits', async ({ page, size }) => {
    await open(page, 'hetzner-1')
    await ready(page).getByRole('button', { name: 'Install' }).click()
    await expect(ready(page).getByRole('heading', { name: 'Installing git' })).toBeVisible()
    await expect(ready(page).getByRole('progressbar', { name: 'Installing on hetzner-1' })).toBeVisible()
    await expect(ready(page).getByRole('status')).toContainText('Running in the background')
    await axe(page)
    await screenshot(page, 'machine-installing', 'install', size)

    await page.reload()
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
    await ready(page).getByRole('button', { name: 'Install' }).click()
    await expect(ready(page).getByRole('status')).toContainText('An install was already running on hetzner-1.')
  })

  test('refused: the daemon’s words', async ({ page }) => {
    await scenario(page, 'refused')
    await page.goto('/m/nas')
    await expect(page.getByText(/^looked /)).toBeVisible({ timeout: 15_000 })
    await ready(page).getByRole('button', { name: 'Install' }).click()
    const alert = ready(page).getByRole('alert')
    await expect(alert).toContainText('Install did not start')
    await expect(alert).toContainText('node biswas-iphone is on this tailnet but is not yours')
  })
})
