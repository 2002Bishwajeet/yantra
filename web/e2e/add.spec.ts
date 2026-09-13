import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'

/** Y-390, D7 §4.2 and walk-through §3: one guided flow per platform, each beat
 *  seen by the appliance and never declared. `adding` holds a device at every
 *  beat — on the tailnet only, joined, joined under another account, ready,
 *  and one whose install stops at sudo — and a node that arrives three
 *  seconds in. */

const COMMAND = 'curl -fsSL http://100.64.0.1:7717/join | sh'
const flow = (machine?: string) => `/machines/add?platform=linux${machine ? `&machine=${machine}` : ''}`
const beat = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 2, name }) })

test.describe('Add a device', () => {
  test('a device only on the tailnet: the join command, a link and a QR code for it', async ({ page, size }) => {
    await scenario(page, 'adding')
    await page.goto(flow('new-box'))
    await expect(beat(page, 'On the tailnet').getByText('done · new-box is on the tailnet')).toBeVisible()
    const joined = beat(page, 'Joined')
    await expect(joined.getByText('waiting · run this in a terminal on new-box')).toBeVisible()
    await expect(joined.getByText(COMMAND)).toBeVisible()
    await expect(joined.getByRole('img', { name: /QR code for .*\/machines\/add\?platform=linux&machine=new-box/ })).toBeVisible()
    await axe(page)
    await screenshot(page, 'add-device', 'adding', size)
  })

  test('a joined device goes ready when Check again asks it', async ({ page }) => {
    await scenario(page, 'adding')
    await page.goto(flow('joined-box'))
    await expect(beat(page, 'Joined').getByText('done · joined as biswa')).toBeVisible()
    await beat(page, 'Reachable over ssh').getByRole('button', { name: 'Check again' }).click()
    await expect(beat(page, 'Reachable over ssh').getByText('done · reachable over ssh')).toBeVisible()
    await expect(beat(page, 'Ready').getByText('waiting · missing claude · Install adds tmux, git and claude')).toBeVisible()
  })

  test('a device joined under another account says so and stops', async ({ page }) => {
    await scenario(page, 'adding')
    await page.goto(flow('kept-box'))
    await expect(
      beat(page, 'Joined').getByText('stuck · joined as biswa, and ssh logs in as yantra; a config you wrote was kept'),
    ).toBeVisible()
    await expect(beat(page, 'Reachable over ssh').getByText('not yet · waits for the join')).toBeVisible()
    await axe(page)
  })

  test('a ready device ends at New session', async ({ page }) => {
    await scenario(page, 'adding')
    await page.goto(flow('ready-box'))
    const ready = beat(page, 'Ready')
    await expect(ready.getByText('done · ready · open a session on ready-box')).toBeVisible()
    // The tablet's navigation rail has a New session of its own.
    await expect(ready.getByRole('link', { name: 'New session' })).toHaveAttribute('href', '/new')
  })

  test('an install that stops at sudo gives each command with Copy', async ({ page, size }) => {
    await scenario(page, 'adding')
    await page.goto(flow('blocked-box'))
    const ready = beat(page, 'Ready')
    await expect(ready.getByText('waiting · missing tmux, claude · Install adds tmux, git and claude')).toBeVisible()
    await ready.getByRole('button', { name: 'Install' }).click()
    await expect(ready.getByText(/^waiting · installing…/)).toBeVisible()
    // The ring is polled every 5 s, and the stop lands 0.8 s after the press.
    await expect(ready.getByText('stuck · tmux needs your password')).toBeVisible({ timeout: 15_000 })
    await expect(ready.getByText('sudo apt-get update; sudo apt-get install -y tmux', { exact: true })).toBeVisible()
    await expect(ready.getByRole('button', { name: 'Copy the command for blocked-box' })).toBeVisible()
    await axe(page)
    await screenshot(page, 'add-device-blocked', 'adding', size)
  })

  test('ticks the first beat by itself when a new node joins the tailnet', async ({ page }) => {
    await scenario(page, 'adding')
    await page.goto(flow())
    await expect(page.getByText('waiting · watching the tailnet for a new Linux machine')).toBeVisible()
    await expect(page.getByText('done · fresh-box is on the tailnet')).toBeVisible({ timeout: 15_000 })
    await expect(page).toHaveURL(/machine=fresh-box/)
  })

  test('selects the join command where the page has no clipboard', async ({ page }) => {
    await scenario(page, 'adding')
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }))
    await page.goto(flow('new-box'))
    await page.getByRole('button', { name: 'Copy the join command' }).click()
    await expect(page.getByText(/this page has no clipboard, so the text is selected/).first()).toBeVisible()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(COMMAND)
  })

  test('ends a phone at the home screen, and says Windows is coming', async ({ page }) => {
    await scenario(page, 'adding')
    await page.goto('/machines/add?platform=mobile&machine=iphone')
    await expect(page.getByText('done · iphone is on the tailnet')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Open the dashboard on it and add it to your home screen' })).toBeVisible()
    await page.getByRole('radio', { name: 'Windows' }).click()
    await expect(page.getByRole('heading', { name: 'Windows · coming soon' })).toBeVisible()
    await axe(page)
  })

  test('opens from Machines and from the checklist', async ({ page }) => {
    await scenario(page, 'adding')
    // The page's own link: on the phone and the tablet the FAB carries it too.
    await page.goto('/machines')
    await page.getByRole('main').getByRole('link', { name: 'Add a device' }).click()
    await expect(page.locator('h1', { hasText: 'Add a device' }).first()).toBeAttached()
    await page.goto('/')
    await page.getByRole('main').getByRole('link', { name: 'Add a device' }).click()
    await expect(page).toHaveURL(/\/machines\/add$/)
  })

  test('walks by keyboard', async ({ page }) => {
    await scenario(page, 'adding')
    await page.goto(flow('new-box'))
    await expect(page.getByText(COMMAND)).toBeVisible()
    await keyboardWalk(page, 8)
  })
})
