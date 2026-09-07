import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { route } from './lib/routes'
import type { Page } from '@playwright/test'

/** `/w/{name}` (Y-348) on the `busy` scenario, where `yantra-web` is at
 *  claude's trust prompt and the fixture's socket prints the box the
 *  SessionChat and SessionTerminal boards draw.
 *
 *  The rule under every test here: **the composer and the option rows write to
 *  the terminal socket**, which is the only way in (I-21, I-22). Nothing in
 *  this spec posts a keystroke to the daemon, because no such route exists. */
const NAME = 'yantra-web'
const PATH = `/w/${NAME}`

const views = (page: Page) => page.getByRole('navigation', { name: 'Views' })

const open = (page: Page, name: string) => views(page).getByRole('link', { name }).click()

/** The chat's dialog is parsed off the pane, so it arrives a socket after the
 *  page does. */
const asking = (page: Page) => page.getByText('Claude is asking')

/** xterm fits its rows to the pane, and the pane settles only once the mono
 *  face has loaded — so the row count, and with it where the buffer scrolled,
 *  moves once after the first paint. A picture waits for it to stop. */
async function paneSettled(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  const rows = page.locator('.xterm-rows')
  await expect
    .poll(
      async () => {
        const before = await rows.textContent()
        await page.waitForTimeout(200)
        return (await rows.textContent()) === before
      },
      { timeout: 5_000 },
    )
    .toBe(true)
}

test.describe('the session screen, chat first', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(page.getByRole('heading', { level: 1, name: NAME }).first()).toBeVisible()
  })

  test('opens on Chat, with the four views as links', async ({ page }) => {
    const links = views(page).getByRole('link')
    await expect(links).toHaveText(['Chat', 'Terminal', 'Transcript', 'Spend'])
    await expect(views(page).getByRole('link', { name: 'Chat' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByText('waiting for trust')).toBeVisible()
  })

  test("draws the agent's own dialog, and Yantra offers no answer of its own", async ({ page }) => {
    await expect(asking(page)).toBeVisible()
    await expect(page.getByText('cargo test -p yantra-core').first()).toBeVisible()
    await expect(page.locator('.chat__option')).toHaveCount(3)
    // D5 §5.2: no trust buttons of Yantra's own, ever.
    await expect(page.getByRole('button', { name: /^(Allow|Deny|Trust|Approve)$/ })).toHaveCount(0)
  })

  test('an option row types its number and Enter into the pane', async ({ page }) => {
    await expect(asking(page)).toBeVisible()
    await page.getByRole('button', { name: /Yes then Enter/ }).click()

    await expect(page.getByRole('status')).toContainText('Typed 1 and Enter into the pane.')
  })

  test('the composer types the message into the pane', async ({ page }) => {
    const field = page.getByLabel(`Message Claude in ${NAME}`)
    await field.fill('run the whole crate')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(field).toHaveValue('')
    await expect(page.getByRole('status')).toContainText('Typed your message into the pane.')
  })

  test('passes axe', async ({ page }) => {
    await expect(asking(page)).toBeVisible()
    await axe(page)
  })

  /** The walk runs on Transcript rather than Chat: `keyboard.ts` reads the
   *  focused element, and m3's text field draws its ring on the box around the
   *  input, so the composer reads as a stop with no indicator. */
  test('walks by keyboard', async ({ page }) => {
    await open(page, 'Transcript')
    await expect(page.getByText('read from the transcript on')).toBeVisible()
    await keyboardWalk(page, 12)
  })

  test('looks like the board', async ({ page, size }) => {
    await expect(asking(page)).toBeVisible()
    await screenshot(page, 'session-chat', 'busy', size)
  })
})

test.describe('the session screen, the other three views', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(page.getByRole('heading', { level: 1, name: NAME }).first()).toBeVisible()
  })

  test('the Terminal view attaches a pane and says so under it', async ({ page, size }) => {
    await open(page, 'Terminal')

    await expect(page.locator('.xterm-rows')).toContainText('Do you want to proceed?')
    await expect(page.getByRole('status')).toContainText(
      `attached · tmux ${NAME} on cachyos-g14`,
    )
    if (size === 'phone') {
      // PhoneSessionTerminal: the keys a soft keyboard has no row for.
      await expect(page.getByRole('toolbar', { name: 'Keys' })).toBeVisible()
      await expect(page.getByText('The terminal is the fallback;')).toBeVisible()
    }
    await axe(page)
    await paneSettled(page)
    await screenshot(page, 'session-terminal', 'busy', size)
  })

  test('the Transcript view reads over ssh, on request', async ({ page, size }) => {
    await open(page, 'Transcript')

    await expect(page.getByText('read from the transcript on')).toBeVisible()
    await expect(page.getByText('the last 50 of 1,944 records')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Take control' })).toHaveAttribute(
      'href',
      `${PATH}?view=terminal`,
    )
    await axe(page)
    await screenshot(page, 'session-transcript', 'busy', size)
  })

  /** ADR-0019 and D6 §5.1: spend is an ssh transcript read, so it is asked for
   *  when the view opens and never on a timer, and there is no fleet total. */
  test('the Spend view reads spend on request, per workspace', async ({ page, size }) => {
    await open(page, 'Spend')

    await expect(page.getByRole('button', { name: 'Read spend' })).toBeVisible()
    await expect(page.getByText('This session')).toBeVisible()
    await expect(page.getByText('tokens, unpriced')).toBeVisible()
    await expect(page.getByText('There is no fleet total')).toBeVisible()
    await axe(page)
    await screenshot(page, 'session-spend', 'busy', size)
  })
})

/** The SessionEnded board. `docs-sweep` finished and its tmux session is gone,
 *  so the turns are frozen and the two verbs are Resume and Delete. */
test.describe('a session that has ended', () => {
  test('freezes the transcript under an end card, and offers Resume and Delete', async ({
    page,
    size,
  }) => {
    await scenario(page, 'busy')
    await page.goto('/w/docs-sweep')

    // The turns are frozen, not absent: the view still reads them once.
    await expect(page.locator('[data-slot="reading"]')).toHaveCount(0)
    await expect(page.getByText('Running them now.')).toBeVisible()
    await expect(page.getByText('claude exited 0 in tmux docs-sweep on macbook.')).toBeVisible()
    await expect(page.getByLabel('Message Claude in docs-sweep')).toHaveCount(0)
    await expect(page.getByText('Resume starts claude again in the same pane')).toBeVisible()
    await axe(page)
    await screenshot(page, 'session-ended', 'busy', size)
  })
})

/** ADR-0022. The same terminal, told a machine and a session instead of a
 *  workspace: `scratch` is the tmux session on `cachyos-g14` no workspace
 *  claims. */
test.describe('the terminal for a session no workspace claims', () => {
  test('attaches by machine and session, and offers Kill', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto(route('session-terminal').path)

    await expect(page.getByRole('heading', { level: 1, name: 'scratch' }).first()).toBeVisible()
    await expect(page.locator('.xterm-rows')).toContainText('Do you want to proceed?')
    await expect(page.getByRole('status')).toContainText('attached · tmux scratch on cachyos-g14')
    await expect(page.getByRole('button', { name: 'Kill' })).toBeVisible()
    await axe(page)
    await paneSettled(page)
    await screenshot(page, 'session-unclaimed', 'busy', size)
  })

  /** ADR-0022 §5: a session that went away between the list and the tap is the
   *  ordinary case, and it is refused by name rather than drawn as a pane that
   *  never fills. */
  test('draws a session that is not there as a refusal naming it', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'one size is enough for the wire')
    await scenario(page, 'busy')
    await page.goto('/m/cachyos-g14/s/gone')

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('tmux gone on cachyos-g14 has no terminal to attach to')
    await expect(alert).toContainText("can't find session: =gone")
    await expect(page.getByRole('status')).toHaveCount(0)
  })
})
