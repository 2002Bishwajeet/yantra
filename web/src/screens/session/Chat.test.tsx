/**
 * The Chat view against a real WebSocket server (`harness.ts`). What matters
 * here is where the words go: **there is no send-keys route** (I-21, I-22), so
 * an option row and the composer both write bytes to the workspace's terminal
 * socket, opened without a screen. Every frame asserted below crossed a socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { Turn, Workspace } from '@/api'
import type { Said } from '@/api/hooks'
import { renderRouted } from '@/test/inRouter'
import { Chat } from './Chat'
import { browser, daemon } from './harness'

const web: Workspace = {
  name: 'yantra-web',
  machine: 'cachyos-g14',
  repo: '/home/biswa/Github/yantra',
  startup: null,
}

/** The box `claude` draws at its trust prompt, as the e2e fixture sends it. */
const BOX = [
  '╭──────────────────────────────────────────────╮',
  '│ Bash command                                 │',
  '│                                              │',
  '│   cargo test -p yantra-core                  │',
  '│                                              │',
  '│ Do you want to proceed?                      │',
  '│ > 1. Yes                                     │',
  "│   2. Yes, and don't ask again for cargo test │",
  '│   3. No, and tell Claude what to do (esc)    │',
  '╰──────────────────────────────────────────────╯',
  '',
  '> ',
].join('\r\n')

const turn: Turn = {
  who: 'claude',
  at: '2026-09-06T11:39:00Z',
  text: 'Running the unit tests first, without the container.',
  tools: [{ name: 'Bash', target: 'cargo test -p yantra-core --lib' }],
}

const held: Said = {
  said: 'held',
  total: 1_944,
  asked: 50,
  turns: [turn],
  at: '2026-09-06T11:59:48Z',
  paging: false,
  moved: false,
}

const settled = <T,>(check: () => T) => waitFor(check, { timeout: 10_000 })

const bytes = (frame: { text: string } | { bytes: number[] }) =>
  'bytes' in frame ? String.fromCharCode(...frame.bytes) : ''

/** Everything the socket carried after the frame that opened the pty. */
const typed = () => daemonised.heard.slice(1).map(bytes).join('')

let daemonised: Awaited<ReturnType<typeof daemon>>
let read: ReturnType<typeof vi.fn<(lines: number, before: number) => void>>

const open = (said: Said = held, state: Parameters<typeof Chat>[0]['state'] = { state: 'awaiting_trust' }) =>
  renderRouted(
    <Chat
      endActions={<button type="button">Resume</button>}
      now={Date.parse('2026-09-06T12:00:00Z')}
      onRead={read}
      paneOpen
      said={said}
      state={state}
      workspace={web}
    />,
  )

beforeEach(async () => {
  browser()
  read = vi.fn<(lines: number, before: number) => void>()
  daemonised = await daemon()
  vi.stubGlobal('location', new URL(`http://127.0.0.1:${daemonised.port}/`))
  // jsdom has no layout, so a chat that scrolls to its newest turn needs this.
  Element.prototype.scrollIntoView = () => {}
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await daemonised.stop()
})

describe('the chat view of a live session', () => {
  it('opens the workspace terminal socket and tells it a window, with no pane on screen', async () => {
    await open()

    await settled(() => expect(daemonised.heard.length).toBe(1))
    expect(daemonised.asked).toEqual(['/api/workspaces/yantra-web/terminal'])
    // The socket is the only way in: nothing here posts keys to the daemon.
    expect(document.querySelector('.xterm')).toBeNull()
  })

  it("draws the agent's own dialog as rows, in the agent's words", async () => {
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.print(BOX)

    await settled(() => expect(screen.getByText('Claude is asking')).toBeTruthy())
    const options = screen.getAllByRole('button', { name: /^[123]/ })
    expect(options).toHaveLength(3)
    expect(options[0]?.textContent).toContain('Yes')
    // D5 §5.2: Yantra offers no verb of its own beside the agent's numbers.
    expect(screen.queryByRole('button', { name: /^(Allow|Trust|Approve|Deny)$/ })).toBeNull()
  })

  it('types the option number and Enter into the pane, and re-reads the transcript', async () => {
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))
    daemonised.print(BOX)
    await settled(() => expect(screen.getByText('Claude is asking')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: /^1/ })[0]!)

    await settled(() => expect(typed()).toBe('1\r'))
    expect(screen.getByRole('status').textContent).toContain('Typed 1 and Enter')
    // The turns come from the file, so an answer is followed by a fresh read.
    expect(read).toHaveBeenCalledWith(50, 0)
  })

  it('types what the composer holds into the pane, and empties it', async () => {
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    const field = screen.getByLabelText('Message Claude in yantra-web')
    fireEvent.change(field, { target: { value: 'run the whole crate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await settled(() => expect(typed()).toBe('run the whole crate\r'))
    expect((field as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('status').textContent).toContain('Typed your message into the pane')
  })

  it('says the pane could not be reached, and offers the Terminal tab, when the socket is refused', async () => {
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.say('ssh: connect to host cachyos-g14 port 22: No route to host')

    await settled(() =>
      expect(screen.getByRole('alert').textContent).toContain('The pane could not be reached'),
    )
    expect(screen.getByRole('alert').textContent).toContain('No route to host')
    expect(screen.getByRole('link', { name: 'Terminal' }).getAttribute('href')).toBe(
      '/w/yantra-web?view=terminal',
    )
  })
})

describe('the chat view of a session that ended', () => {
  it('freezes the turns under an end card, and offers no composer', async () => {
    await open(held, { state: 'finished' })

    expect(screen.getByText(/claude exited 0 in tmux yantra-web on cachyos-g14/)).toBeTruthy()
    expect(screen.getByText(turn.text)).toBeTruthy()
    expect(screen.queryByLabelText('Message Claude in yantra-web')).toBeNull()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
    // Nothing is attached to a session nobody is talking to (ADR-0019).
    expect(daemonised.asked).toEqual([])
  })
})
