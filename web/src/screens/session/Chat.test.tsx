/**
 * The Chat view against a real WebSocket server (`harness.ts`). The daemon's
 * side is played from `contract.gen.ts`, which is what `yantrad` really
 * serialises, and every frame asserted below crossed a socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Workspace } from '@/api'
import type { Harness, ThreadEvent } from '@/api/thread'
import { chatEvents, chatNotLoggedIn } from '@/contract.gen'
import { Chat } from './Chat'
import { browser, daemon } from './harness'

const web: Workspace = {
  name: 'yantra-web',
  machine: 'cachyos-g14',
  repo: '/home/biswa/Github/yantra',
  startup: null,
}

const settled = <T,>(check: () => T) => waitFor(check, { timeout: 10_000 })

let server: Awaited<ReturnType<typeof daemon>>
let onThread: ReturnType<typeof vi.fn<(thread: string) => void>>

const of = (type: ThreadEvent['type']) => chatEvents.find((event) => event.type === type)!
const say = (event: unknown) => server.say(JSON.stringify(event))
const started = (harness: Harness = 'claude') => ({ ...of('thread.started'), payload: { thread: '1a2b3c4d', harness } })
const frames = () => server.heard.map((frame) => ('text' in frame ? JSON.parse(frame.text) : frame))

async function open(thread?: string) {
  render(<Chat onThread={onThread} thread={thread} workspace={web} />)
  await settled(() => expect(server.asked).toHaveLength(1))
  // The empty line appears once the socket is open.
  await settled(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText('Message Claude in yantra-web'), { target: { value: text } })
}

beforeEach(async () => {
  browser()
  onThread = vi.fn<(thread: string) => void>()
  server = await daemon()
  vi.stubGlobal('location', new URL(`http://127.0.0.1:${server.port}/`))
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await server.stop()
})

describe('the harness picker', () => {
  it('offers every harness with Claude first, and sends the one picked with the first turn', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Harness: Claude' }))
    const options = await settled(() => screen.getAllByRole('menuitemradio'))
    expect(options.map((one) => one.textContent)).toEqual(['Claude', 'Codex', 'Gemini', 'Grok', 'opencode'])
    expect(options[0].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(options[4])
    await settled(() => expect(screen.getByRole('button', { name: 'Harness: opencode' })).toBeTruthy())
    // An open menu's backdrop covers Send, so the pick closes it.
    await settled(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.change(screen.getByLabelText('Message opencode in yantra-web'), { target: { value: 'list the files' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(frames()).toEqual([{ type: 'turn', text: 'list the files', harness: 'opencode' }]))
    expect(screen.getByRole('status').textContent).toBe('opencode is answering.')
  })

  it("locks once the daemon names the thread's harness, and a later turn carries none", async () => {
    await open()
    say(started('codex'))
    const kept = await settled(() => screen.getByRole('button', { name: 'Harness: Codex, kept by this chat' }))
    expect(kept).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: 'Harness: Codex' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Message Codex in yantra-web'), { target: { value: 'again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(frames()).toEqual([{ type: 'turn', text: 'again' }]))
  })

  it("draws opencode's events on the same timeline as Claude's", async () => {
    await open()
    say(started('opencode'))
    say(of('turn.started'))
    say({ threadId: '1a2b3c4d', type: 'content.delta', payload: { streamKind: 'assistant_text', delta: 'Listing **files**.', itemId: 'prt_1' } })
    say(of('item.started'))
    say(of('request.opened'))

    const strong = await settled(() => screen.getByText('files'))
    expect(strong.tagName).toBe('STRONG')
    expect(strong.closest('article')?.getAttribute('data-who')).toBe('agent')
    expect(within(strong.closest('article')!).getByText('opencode')).toBeTruthy()
    const card = screen.getAllByText('cargo test')[0].closest('article')!
    expect(within(card).getByText('Command')).toBeTruthy()
    expect(screen.getByText('opencode asks to run')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop opencode' })).toBeTruthy()
  })

  it('draws a missing login with the machine and the command, and Retry reopens the socket', async () => {
    await open()
    say(chatNotLoggedIn)
    const alert = await settled(() => screen.getByRole('alert'))
    expect(within(alert).getByRole('heading').textContent).toBe('opencode is not logged in on cachyos-g14')
    expect(alert.textContent).toContain('Run this on cachyos-g14, then retry.')
    expect(within(alert).getByText('opencode auth login')).toBeTruthy()
    expect(within(alert).getByRole('button', { name: 'Copy how to log opencode in' })).toBeTruthy()
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
    // Every turn would fail the same way until someone logs in.
    expect(screen.getByLabelText<HTMLInputElement>('Message Claude in yantra-web').disabled).toBe(true)

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await settled(() => expect(server.asked).toHaveLength(2))
    await settled(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('draws the bad frame the daemon sends for a harness it refused', async () => {
    await open()
    say({ type: 'error', kind: 'badFrame', said: 'this thread is claude’s, and a thread keeps its harness' })
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('The daemon could not read what the dashboard sent.')
    expect(alert.textContent).toContain('a thread keeps its harness')
  })
})

describe('the chat', () => {
  it('opens on an empty conversation, and says why Send is off', async () => {
    await open()
    expect(server.asked).toEqual(['/api/workspaces/yantra-web/chat'])
    await settled(() => expect(screen.getByText(/Ask Claude something about yantra-web/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Type a message to send it.')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('own worktree on cachyos-g14')
  })

  it('attaches to the thread the URL names', async () => {
    await open('1a2b3c4d')
    expect(server.asked).toEqual(['/api/workspaces/yantra-web/chat?thread=1a2b3c4d'])
  })

  it('sends a turn, keeps the new thread in the URL, and streams the answer as Markdown', async () => {
    await open()
    type('run the tests')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await settled(() => expect(frames()).toEqual([{ type: 'turn', text: 'run the tests', harness: 'claude' }]))
    expect(screen.getByLabelText<HTMLInputElement>('Message Claude in yantra-web').value).toBe('')
    expect(screen.getByRole('status').textContent).toBe('Claude is answering.')

    say(started())
    await settled(() => expect(onThread).toHaveBeenCalledWith('1a2b3c4d'))
    say({ threadId: '1a2b3c4d', type: 'content.delta', payload: { streamKind: 'user_text', delta: 'run the tests', itemId: 'user:1' } })
    say(of('turn.started'))
    say({ threadId: '1a2b3c4d', type: 'content.delta', payload: { streamKind: 'assistant_text', delta: 'Running **the', itemId: 'm:1' } })
    say({ threadId: '1a2b3c4d', type: 'content.delta', payload: { streamKind: 'assistant_text', delta: ' tests**.', itemId: 'm:1' } })

    const strong = await settled(() => screen.getByText('the tests'))
    expect(strong.tagName).toBe('STRONG')
    expect(screen.getByText('run the tests').closest('article')?.getAttribute('data-who')).toBe('you')
    // While a turn runs, Stop stands where Send was.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop Claude' })).toBeTruthy()
  })

  it('never renders raw HTML from a reply', async () => {
    await open()
    say({ threadId: 't', type: 'content.delta', payload: { streamKind: 'assistant_text', delta: '<img src=x onerror="alert(1)"> hi', itemId: 'm:1' } })
    await settled(() => expect(document.querySelector('.chat__markdown')?.textContent).toContain('hi'))
    expect(document.querySelector('img')).toBeNull()
  })

  it('draws a tool as a card with its status, command and output', async () => {
    await open()
    say(of('item.started'))
    const card = await settled(() => screen.getByText('cargo test').closest('article')!)
    expect(within(card).getByText('Command')).toBeTruthy()
    expect(within(card).getByText('running')).toBeTruthy()

    say(of('item.completed'))
    await settled(() => expect(within(card).getByText('done')).toBeTruthy())
    expect(within(card).getByText('test result: ok')).toBeTruthy()
  })

  it.each([
    ['Accept', 'accept'],
    ['Accept always', 'acceptAlways'],
    ['Decline', 'decline'],
  ] as const)('sends %s as its decision, and the card goes when it is resolved', async (label, decision) => {
    await open()
    say(of('request.opened'))
    await settled(() => expect(screen.getByText('Claude asks to run')).toBeTruthy())
    expect(screen.getByText('Run the unit tests')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Claude is waiting for your answer.')

    fireEvent.click(screen.getByRole('button', { name: label }))
    await settled(() => expect(frames()).toEqual([{ type: 'answer', requestId: 'r1', decision }]))

    say({ ...of('request.resolved'), payload: { requestId: 'r1', requestType: 'exec_command_approval', decision } })
    await settled(() => expect(screen.queryByText('Claude asks to run')).toBeNull())
  })

  it('takes one answer per request, so a double tap sends one frame', async () => {
    await open()
    say(of('request.opened'))
    const accept = await settled(() => screen.getByRole('button', { name: 'Accept' }))
    fireEvent.click(accept)
    fireEvent.click(accept)
    await settled(() => expect(frames()).toHaveLength(1))
    expect(accept).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Decline' })).toHaveProperty('disabled', true)
  })

  it('keeps Stop through a badFrame, because a bad frame never ends a turn', async () => {
    await open()
    type('run the tests')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    say(of('turn.started'))
    await settled(() => screen.getByRole('button', { name: 'Stop Claude' }))

    say({ type: 'error', kind: 'badFrame', said: 'no request r1 is pending' })
    await settled(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Stop Claude' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Claude is answering.')
  })

  it('stops a running turn, and says it stopped', async () => {
    await open()
    type('count to 400')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    say(of('turn.started'))
    fireEvent.click(await settled(() => screen.getByRole('button', { name: 'Stop Claude' })))

    await settled(() => expect(frames()).toContainEqual({ type: 'cancel' }))
    expect(screen.getByRole('status').textContent).toBe('Stopping Claude…')
    say({ threadId: 't', type: 'turn.completed', payload: { state: 'cancelled', stopReason: 'cancelled' } })
    await settled(() => expect(screen.getByRole('status').textContent).toBe('Claude stopped.'))
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('shows the context the last turn used', async () => {
    await open()
    say(of('thread.token-usage.updated'))
    const meter = await settled(() => screen.getByRole('meter', { name: 'Context used' }))
    expect(meter.getAttribute('value')).toBe('29149')
    expect(screen.getByText('context 15% · 29k of 200k')).toBeTruthy()
  })

  it("draws a failed turn in Claude's own words", async () => {
    await open()
    say(chatEvents[chatEvents.length - 1])
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('The turn failed')
    expect(alert.textContent).toContain('Not logged in · Please run /login')
    // Asking again would fail the same way.
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('draws a closed socket, and Try again reopens it on the same thread', async () => {
    await open()
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalled())
    server.hangUp()
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('The chat socket closed')
    expect(screen.getByLabelText<HTMLInputElement>('Message Claude in yantra-web').disabled).toBe(true)

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await settled(() => expect(server.asked).toHaveLength(2))
    expect(server.asked[1]).toBe('/api/workspaces/yantra-web/chat?thread=1a2b3c4d')
    await settled(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('draws a refused socket, with nothing to retry', async () => {
    const port = server.port
    await server.stop()
    render(<Chat onThread={onThread} workspace={web} />)
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('The daemon refused the chat')
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
    expect(port).toBeGreaterThan(0)
    server = await daemon()
  })

  it('draws a machine it could not reach, and a busy daemon', async () => {
    await open()
    say({ type: 'error', kind: 'unreachable', said: 'ssh: connect to host cachyos-g14 port 22: Connection refused' })
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('Connection refused')
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy()

    say({ type: 'error', kind: 'busy', said: 'a turn is running' })
    await settled(() => expect(screen.getByRole('alert').textContent).toContain('The agent is still answering'))
  })
})
