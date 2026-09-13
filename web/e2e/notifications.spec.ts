import { axe, expect, scenario, screenshot, test } from './lib/test'

/** Y-399: install and join events carry an action and their commands, a
 *  mismatched `joined` shows its full warning rather than cutting it off, and
 *  the footer reads the daemon's own relay state.
 *
 *  The bell's own popover or sheet is mounted from first paint so its name
 *  resolves (`Shell.tsx`'s `SHEET` comment), so every query here is scoped to
 *  `main` — the route's own list — and never the bare page. */
test.describe('install and join rows on notifications', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'notifications')
    await page.goto('/notifications')
    await expect(page.getByRole('main').getByText('needs your password')).toBeVisible()
  })

  test('shows every command via Copyable, the full warning, and Open', async ({ page, size }) => {
    const main = page.getByRole('main')

    const install = main.locator('li').filter({ hasText: 'pi-5 needs your password' })
    await expect(install.getByText('sudo apt-get update; sudo apt-get install -y tmux')).toBeVisible()
    await expect(install.getByRole('button', { name: 'Copy the command' })).toBeVisible()
    await expect(install.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/m/pi-5')

    const warning =
      'thinkpad joined as biswa, but the ssh config logs in there as someone-else, so Yantra cannot reach it until the owner edits that config'
    await expect(main.getByText(warning)).toBeVisible()
    await expect(main.getByText('thinkpad joined, as another account')).toBeVisible()

    await expect(main.getByText('macbook joined')).toBeVisible()
    await expect(main.getByText('as biswa', { exact: true })).toBeVisible()

    await expect(main.getByText('hetzner-1 is ready')).toBeVisible()

    await expect(main.getByText('Push to your phone is on')).toBeVisible()

    // S7/B2: the warning wraps rather than pushing the page wider than the
    // viewport it is drawn in.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    await screenshot(page, 'notifications-events', 'notifications', size)
    await axe(page)
  })
})
