import type { Page } from '@playwright/test'
import { axe, expect, scenario, screenshot, test } from './lib/test'

/** Y-682: hold to dictate in the Chat (ADR-0043 §4, §6). The microphone is an
 *  oscillator, so the real AudioWorklet path runs, and the daemon's dictation
 *  socket is a route that answers as dictate.rs does. */
const NAME = 'yantra-web'
const PATH = `/w/${NAME}`

const LISTENING = 'Listening. Let go to write it in.'
const WRITING = 'Writing down what you said…'
const FAILED = 'The speech service failed, so nothing was written.'
const UNREACHABLE = 'Dictation is off: yantra-box does not answer.'

const composer = (page: Page) => page.getByLabel(`Message Claude in ${NAME}`, { exact: true })
const dictate = (page: Page) => page.getByRole('button', { name: 'Hold to dictate' })
const line = (page: Page, words: string) => page.getByRole('status').filter({ hasText: words })

/** The daemon's side: /api/dictate/health answers `state`, and the socket takes
 *  the frames and `end` and answers only when the test says so. */
async function daemon(page: Page, state: 'ready' | 'unreachable') {
  const health = { asked: 0 }
  await page.route('**/api/dictate/health', (route) => route.fulfill({ json: { state } }))
  // Counted as requests, not as routed ones: Playwright's WebKit lets the ask made inside the socket's
  // message handler past the route, to the fixture's 404, and the page keeps the last answer.
  page.on('request', (request) => {
    if (request.url().endsWith('/api/dictate/health')) health.asked += 1
  })
  const heard = { frames: 0, ended: false }
  let answer: ((frame: object) => void) | undefined
  await page.routeWebSocket(/\/api\/dictate(\?|$)/, (socket) => {
    socket.onMessage((frame) => {
      if (frame === 'end') heard.ended = true
      else if (typeof frame !== 'string') heard.frames += 1
    })
    answer = (frame) => socket.send(JSON.stringify(frame))
  })
  const reply = async (frame: object) => {
    await expect.poll(() => heard.ended).toBe(true)
    answer!(frame)
  }
  return { health, heard, reply }
}

/** Every frame the page sends on a socket other than dictation's, such as the chat's turn. */
function sentElsewhere(page: Page) {
  const sent: string[] = []
  page.on('websocket', (socket) => {
    if (socket.url().includes('/api/dictate')) return
    socket.on('framesent', (frame) => sent.push(String(frame.payload)))
  })
  return sent
}

async function open(page: Page) {
  // A tone through a MediaStream: what getUserMedia hands the page, without a device.
  await page.addInitScript(() => {
    const tone = async () => {
      const context = new AudioContext()
      const oscillator = context.createOscillator()
      const out = context.createMediaStreamDestination()
      oscillator.connect(out)
      oscillator.start()
      await context.resume().catch(() => {})
      return out.stream
    }
    // On the prototype: WebKit's page reads another MediaDevices than the one an init script sees.
    MediaDevices.prototype.getUserMedia = tone
  })
  await scenario(page, 'busy')
  await page.goto(PATH)
  await expect(page.getByRole('heading', { level: 1, name: NAME }).first()).toBeVisible()
}

/** A finger or a mouse held on the button. The capture keeps the hold while the page resizes for a picture. */
async function hold(page: Page) {
  const box = (await dictate(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
}

test.describe('hold to dictate', () => {
  test('rests in the footer, listens while held, writes, and puts the words at the caret', async ({ page, size }) => {
    const sent = sentElsewhere(page)
    const fake = await daemon(page, 'ready')
    await open(page)

    // (a) At rest: in the footer, with nothing said.
    await expect(dictate(page)).toBeEnabled()
    await expect(page.locator('.composer__footer').getByRole('button', { name: 'Hold to dictate' })).toBeVisible()
    await expect(dictate(page)).toHaveAttribute('aria-pressed', 'false')
    await screenshot(page, 'dictate-rest', 'busy', size, { overlay: size === 'phone' })

    await composer(page).fill('Please now')
    await composer(page).evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(7, 7))
    const before = sent.length

    // (b) Held: listening, pressed, and audio going out.
    await hold(page)
    await expect(line(page, LISTENING)).toHaveText(LISTENING)
    await expect(dictate(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(dictate(page)).toHaveAttribute('data-state', 'listening')
    await expect.poll(() => fake.heard.frames).toBeGreaterThan(0)
    await screenshot(page, 'dictate-listening', 'busy', size, { overlay: size === 'phone' })

    // (c) Let go: `end` goes out and the socket waits for the words.
    await page.mouse.up()
    await expect(line(page, WRITING)).toHaveText(WRITING)
    await expect(dictate(page)).toHaveAttribute('aria-busy', 'true')
    await expect(dictate(page)).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => fake.heard.ended).toBe(true)
    await screenshot(page, 'dictate-writing', 'busy', size, { overlay: size === 'phone' })

    // (d) The words land at the caret, as a draft: no Send, no chat frame.
    await fake.reply({ text: 'run the core tests' })
    await expect(composer(page)).toHaveValue('Please run the core tests now')
    expect(await composer(page).evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(25)
    await expect(dictate(page)).toBeEnabled()
    await expect(dictate(page)).not.toHaveAttribute('aria-busy', 'true')
    await expect(line(page, LISTENING)).toHaveCount(0)
    await expect(line(page, WRITING)).toHaveCount(0)
    expect(sent.slice(before)).toEqual([])
    await expect(page.getByRole('region', { name: 'Conversation' }).getByText('run the core tests')).toHaveCount(0)
    await screenshot(page, 'dictate-answered', 'busy', size, { overlay: size === 'phone' })
  })

  test('Space holds it from the keyboard', async ({ page }) => {
    const fake = await daemon(page, 'ready')
    await open(page)
    await dictate(page).focus()
    await page.keyboard.down('Space')
    await expect(line(page, LISTENING)).toHaveText(LISTENING)
    await expect(dictate(page)).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => fake.heard.frames).toBeGreaterThan(0)
    await page.keyboard.up('Space')
    await expect(line(page, WRITING)).toHaveText(WRITING)
    await fake.reply({ text: 'use tokio' })
    await expect(composer(page)).toHaveValue('use tokio')
  })

  test('a failed service says why in the error tone, then the button asks again', async ({ page, size }) => {
    const fake = await daemon(page, 'ready')
    await open(page)
    await expect(dictate(page)).toBeEnabled()
    const asked = fake.health.asked

    await hold(page)
    await expect(line(page, LISTENING)).toHaveText(LISTENING)
    await page.mouse.up()
    // dictate.rs names the kind `failed`; the page reads it as `stt-failed`.
    await fake.reply({ error: 'failed', said: 'the service answered 500: did not decode' })

    const error = line(page, FAILED)
    await expect(error).toHaveText(FAILED)
    await expect(error).toHaveAttribute('data-tone', 'error')
    await expect(composer(page)).toHaveValue('')
    await expect.poll(() => fake.health.asked).toBe(asked + 1)
    await expect(dictate(page)).toBeEnabled()
    await screenshot(page, 'dictate-error', 'busy', size, { overlay: size === 'phone' })
  })

  test('a box that does not answer disables the button and says why', async ({ page, size }) => {
    await daemon(page, 'unreachable')
    await open(page)
    await expect(dictate(page)).toBeDisabled()
    const reason = line(page, UNREACHABLE)
    await expect(reason).toHaveText(UNREACHABLE)
    await expect(reason).toHaveAttribute('data-tone', 'error')
    await expect(dictate(page)).toHaveAttribute('aria-describedby', (await reason.getAttribute('id'))!)
    await screenshot(page, 'dictate-unreachable', 'busy', size, { overlay: size === 'phone' })
  })
})

test.describe('hold to dictate on a phone', () => {
  test.beforeEach(({ size }) => {
    test.skip(size !== 'phone', 'the phone rules')
  })

  test('fits one footer row with a 48 px target, passes axe, and opens no long-press menu', async ({ page }) => {
    await daemon(page, 'ready')
    await open(page)
    await expect(dictate(page)).toBeEnabled()

    // Every footer control, Dictate among them, sits in one row, and nothing scrolls sideways.
    const row = await page.locator('.composer__footer').evaluate((footer) => {
      const tops = [...footer.querySelectorAll('button')]
        .filter((one) => one.getBoundingClientRect().width > 0)
        .map((one) => Math.round(one.getBoundingClientRect().top + one.getBoundingClientRect().height / 2))
      const controls = footer.querySelector<HTMLElement>('.composer__controls')!
      const root = document.scrollingElement!
      return {
        rows: new Set(tops).size,
        count: tops.length,
        footerScrolls: controls.scrollWidth > controls.clientWidth,
        pageScrolls: root.scrollWidth > root.clientWidth,
      }
    })
    expect(row.count).toBeGreaterThan(1)
    expect(row).toMatchObject({ rows: 1, footerScrolls: false, pageScrolls: false })

    // The hit area is the button's `::after`, which reaches past the 32 px it draws.
    const target = await dictate(page).evaluate((button) => {
      const rect = button.getBoundingClientRect()
      const after = getComputedStyle(button, '::after')
      const out = (side: string) => -Math.min(0, parseFloat(side))
      return {
        width: rect.width + out(after.left) + out(after.right),
        height: rect.height + out(after.top) + out(after.bottom),
      }
    })
    expect(target.width).toBeGreaterThanOrEqual(48)
    expect(target.height).toBeGreaterThanOrEqual(48)

    // A long press is a hold, so it must not open the browser's menu or select the icon.
    const menu = await dictate(page).evaluate((button) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      button.dispatchEvent(event)
      const style = getComputedStyle(button)
      return {
        prevented: event.defaultPrevented,
        select: style.userSelect || style.webkitUserSelect,
        touchAction: style.touchAction,
      }
    })
    expect(menu).toEqual({ prevented: true, select: 'none', touchAction: 'none' })

    await axe(page)
    await hold(page)
    await expect(line(page, LISTENING)).toHaveText(LISTENING)
    await axe(page)
    await page.mouse.up()
  })
})
