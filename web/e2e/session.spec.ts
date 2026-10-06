import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { route } from './lib/routes'
import type { Page } from '@playwright/test'

/** `/w/{name}` (Y-348) on the `busy` scenario. The Chat tab streams over the
 *  chat socket (Y-356, ADR-0026), and the fixture replays what `yantrad`
 *  serialises: a turn streams as far as Claude's permission request and ends
 *  once it is answered. The Terminal tab is still the tmux pane. */
const NAME = 'yantra-web'
const PATH = `/w/${NAME}`
const THREAD = '1a2b3c4d'

const views = (page: Page) => page.getByRole('navigation', { name: 'Views' })

const open = (page: Page, name: string) => views(page).getByRole('link', { name }).click()

/** Claude's request arrives a socket and a turn after the page does. */
const asking = (page: Page) => page.getByText('Claude asks to run')

/** The composer's label. The PhoneSessionChat board writes the short one, and
 *  the desktop boards name the workspace (finding 114). */
const composer = (page: Page, size: string) =>
  page.getByLabel(size === 'phone' ? 'Message Claude' : `Message Claude in ${NAME}`, {
    exact: true,
  })

async function turn(page: Page, size: string) {
  await composer(page, size).fill('run the core tests')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(asking(page)).toBeVisible()
}

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
    // The header, because the reason Resume gives for being off names the
    // state too, and that reason is not on screen.
    await expect(page.locator('.session__name')).toContainText('waiting for trust')
  })

  test("streams a turn, and draws Claude's request with three answers", async ({ page, size }) => {
    await turn(page, size)
    await expect(page.getByText('Running the tests.')).toBeVisible()
    await expect(page.getByText('cargo test').first()).toBeVisible()
    for (const name of ['Accept', 'Accept always', 'Decline']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await expect(page.getByRole('status')).toHaveText('Claude is waiting for your answer.')
    // The new thread is in the URL, so a reload continues it.
    await expect(page).toHaveURL(new RegExp(`thread=${THREAD}`))
  })

  test('Accept answers the request, and the turn ends with its output and usage', async ({ page, size }) => {
    await turn(page, size)
    await page.getByRole('button', { name: 'Accept', exact: true }).click()

    await expect(asking(page)).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
    await expect(page.getByRole('meter', { name: 'Context used' })).toBeVisible()
    await page.getByText('Output').click()
    await expect(page.getByText('test result: ok')).toBeVisible()
  })

  test('Stop cancels a turn that is waiting', async ({ page, size }) => {
    await turn(page, size)
    await page.getByRole('button', { name: 'Stop Claude' }).click()
    await expect(page.getByRole('status')).toHaveText('Claude stopped.')
    await expect(asking(page)).toHaveCount(0)
  })

  test('a thread in the URL replays its transcript', async ({ page }) => {
    await page.goto(`${PATH}?thread=${THREAD}`)
    await expect(page.getByText('Is the core crate green?')).toBeVisible()
    await expect(page.locator('.chat__markdown strong')).toHaveText('326')
  })

  test('a thread the workspace does not have is refused by name', async ({ page }) => {
    await page.goto(`${PATH}?thread=ffffffff`)
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('This workspace has no chat with that id.')
    await expect(alert).toContainText(`${NAME} has no chat thread ffffffff`)
  })

  test('passes axe', async ({ page, size }) => {
    await turn(page, size)
    await axe(page)
  })

  /** **Finding 114.** The PhoneSessionChat board shortens the strings the
   *  desktop boards write in full. */
  test('writes the phone board’s strings at 390 and the desktop ones above it', async ({
    page,
    size,
  }) => {
    await expect(composer(page, size)).toBeVisible()
    await expect(page.getByRole('status')).toHaveText(
      size === 'phone'
        ? 'Each turn runs in this chat’s own worktree.'
        : 'Each turn runs claude in this chat’s own worktree on cachyos-g14, apart from the terminal’s.',
    )
  })

  /** **Finding 120.** `yantra-web` is waiting for trust, so Resume is off and
   *  Send is off until something is typed. Neither may go quiet about it. */
  test('says why Send and Resume are off', async ({ page, size }) => {
    await expect(page.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription(
      'Type a message to send it.',
    )
    await expect(page.getByRole('button', { name: 'Resume' })).toHaveAccessibleDescription(
      `Resume needs an agent that has ended, and ${NAME} is waiting for trust.`,
    )

    await composer(page, size).fill('run the whole crate')
    await expect(page.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription('')
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
    await turn(page, size)
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

  /** **WCAG 2.1.2, and the worst thing the review found.** xterm hands Tab to
   *  the shell — `Keys.tsx` ships a Tab button because of it — so the pane needs
   *  an exit that is not Tab. Escape then Tab is it, and the line under the pane
   *  is where a keyboard reads that. */
  test('lets a keyboard leave the pane, and still sends Tab to the shell', async ({ page }) => {
    await open(page, 'Terminal')
    await expect(page.locator('.xterm-rows')).toContainText('Do you want to proceed?')
    await expect(page.getByText('Esc then Tab leaves the pane')).toBeVisible()

    const pane = page.locator('.xterm-helper-textarea')
    await pane.focus()
    await expect(pane).toBeFocused()

    // Tab on its own is the shell's, and moves no focus.
    await page.keyboard.press('Tab')
    await expect(pane).toBeFocused()

    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    await expect(pane).not.toBeFocused()
    await expect(page.locator('.terminal__status')).toBeFocused()
  })

  /** **4.1.2, finding 108.** The key row calls itself a toolbar, so it owes a
   *  keyboard one tab stop and the arrow keys inside it. */
  test('walks the phone key row with the arrow keys, from one tab stop', async ({ page, size }) => {
    test.skip(size !== 'phone', 'the key row is the phone board')
    await open(page, 'Terminal')
    const row = page.getByRole('toolbar', { name: 'Keys' })
    await expect(row).toBeVisible()

    const keys = row.getByRole('button')
    await keys.first().focus()
    await page.keyboard.press('ArrowRight')
    await expect(keys.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(keys.last()).toBeFocused()

    // One stop: Tab leaves the row rather than walking the other six keys.
    await page.keyboard.press('Tab')
    await expect(row.locator(':focus')).toHaveCount(0)
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
    // Finding 132: the board sends the answer to the pane, which is Terminal.
    await expect(page.getByRole('link', { name: 'Terminal tab' })).toHaveAttribute(
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
    // Finding 128: the board dates the price table `4 Sep`, not `2026-08-11`.
    await expect(page.getByText('prices as of 11 Aug')).toBeVisible()
    await axe(page)
    await screenshot(page, 'session-spend', 'busy', size)
  })
})

/** `docs-sweep` finished and its tmux session is gone. The chat runs in a
 *  worktree of its own, so it stays open; Resume is the header's. */
test.describe('a session that has ended', () => {
  test('keeps the chat open, and offers Resume in the header', async ({ page, size }) => {
    await scenario(page, 'busy')
    await page.goto('/w/docs-sweep')

    await expect(
      page.getByLabel(size === 'phone' ? 'Message Claude' : 'Message Claude in docs-sweep', { exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeEnabled()
    await axe(page)
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
    // 4.1.3: the line that speaks while the pane is live is the one that has to
    // carry the end, so it stays rather than going with what ended it.
    await expect(page.getByRole('status')).toContainText('refused · tmux gone on cachyos-g14')
  })
})
