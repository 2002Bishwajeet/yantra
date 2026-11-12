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
    // pi-5 still has no gh installed, so the next thing is gh, and a session may start.
    await expect(ready(page).getByRole('heading', { name: 'gh installed is missing' })).toBeVisible({ timeout: 15_000 })
    await expect(ready(page).getByText(/^8 of 10 · asked/)).toBeVisible()
    await ready(page).getByRole('button', { name: /^Show What ssh said/ }).click()
    await expect(ready(page).getByText(/neither `gh` nor `glab`/)).toBeVisible()
    await expect(ready(page).getByText(/installed by Yantra/)).toHaveCount(0)
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

  /* Y-778, ADR-0030's note of 2026-11-12: the password step goes to the owner terminal. */
  test('sudo: the step is typed into the owner terminal, and the password is only keystrokes', async ({ page, size }) => {
    await open(page, 'nas')
    await ready(page).getByRole('button', { name: 'Install' }).click()
    await ready(page).getByRole('button', { name: 'Run in owner terminal' }).click({ timeout: 15_000 })

    const sheetNamed = (name: string) =>
      size === 'phone' ? page.getByRole('dialog', { name }) : page.getByRole('complementary', { name })
    // This browser keeps no admin account for nas, so the sheet asks for it first.
    const asking = sheetNamed('Owner terminal on nas')
    await asking.getByRole('textbox', { name: 'Admin account' }).fill('owner')
    await asking.getByRole('button', { name: 'Open owner terminal' }).click()

    const sheet = sheetNamed('owner on nas')
    const rows = sheet.locator('.xterm-rows')
    await expect(sheet).toBeVisible()
    // The command is typed in and not sent: sudo has not asked yet. A narrow
    // pane wraps the line, and a wrap can take the space at the row's end.
    await expect(rows).toContainText(/install\s*-y\s*tmux\s*curl/, { timeout: 15_000 })
    await expect(rows).not.toContainText('password for owner')
    await axe(page)

    await sheet.locator('.xterm-helper-textarea').focus()
    // Escape is the shell's inside the sheet: closing on it would hang up sudo.
    await page.keyboard.press('Escape')
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(rows).toContainText('password for owner')
    await page.keyboard.type('hunter2')
    await page.keyboard.press('Enter')
    // sudo took the password and ran; the shell drew its prompt again.
    await expect(rows).toContainText(/password for owner:\s*0\s*owner@nas/)
    await expect(rows).not.toContainText('hunter2')

    await sheet.getByRole('button', { name: size === 'phone' ? 'Close' : 'Close owner on nas' }).click()
    await expect(sheet).toBeHidden()
    // The step installed tmux, so claude is what is left, and Install asks for it.
    const title = ready(page).getByRole('heading', { name: 'claude is missing' })
    await expect(title).toBeVisible({ timeout: 15_000 })
    // The pressed button went with the verdict, so focus is on the card's title.
    await expect(title).toBeFocused()
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
