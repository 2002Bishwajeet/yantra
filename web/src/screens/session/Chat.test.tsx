/**
 * The Chat view against a real WebSocket server (`harness.ts`). The daemon's
 * side is played from `contract.gen.ts`, which is what `yantrad` really
 * serialises, and every frame asserted below crossed a socket.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, fireEvent, render as bare, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { Workspace } from '@/api'
import type { Harness, ThreadEvent } from '@/api/thread'
import { IMAGE_LIMIT } from '@/api/chat'
import {
  chatAttached,
  chatBranchDiff,
  chatCheckpointFailed,
  chatCheckpoints,
  chatDiffFailed,
  chatFailure,
  chatEvents,
  chatNotAttached,
  chatNotLoggedIn,
  chatQueue,
  chatStopTaskFailed,
  pulls,
  threads,
} from '@/contract.gen'
import { aMentions, commands as claudeCommands } from '@/api/fixtures'
import { writePrefs } from '@/shell/prefs'
import { Chat } from './Chat'
import { browser, daemon } from './harness'

// Pierre's viewer is its own test file's business (diff/DiffViewer.test.tsx).
const seen: unknown[] = []
vi.mock('./diff/DiffViewer', () => ({
  default: (props: {
    data: { unified: string; truncated: boolean }
    quiet?: boolean
    onComment: (block: string) => void
  }) => {
    seen.push(props.data)
    return (
      <pre data-quiet={String(props.quiet === true)} data-truncated={String(props.data.truncated)} data-testid="viewer">
        {props.data.unified}
        <button onClick={() => props.onComment('> a.rs:L1\n> +x\n\nrename it')} type="button">
          stub comment
        </button>
      </pre>
    )
  },
}))

const web: Workspace = {
  name: 'yantra-web',
  machine: 'cachyos-g14',
  repo: '/home/biswa/Github/yantra',
  startup: null,
}

const render = (ui: ReactElement) =>
  bare(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{ui}</QueryClientProvider>)

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
  seen.length = 0
  localStorage.clear()
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

describe('the initial draft', () => {
  it('seeds the composer with the issue text and leaves it editable', async () => {
    render(<Chat initialDraft="Work on o/r#1: a title" onThread={onThread} workspace={web} />)
    await settled(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())
    const composer = screen.getByLabelText('Message Claude in yantra-web') as HTMLTextAreaElement
    expect(composer.value).toBe('Work on o/r#1: a title')
    type('changed')
    expect(composer.value).toBe('changed')
  })

  it('starts empty without one', async () => {
    await open()
    expect((screen.getByLabelText('Message Claude in yantra-web') as HTMLTextAreaElement).value).toBe('')
  })
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
    await settled(() => expect(frames()).toEqual([{ type: 'turn', text: 'list the files', harness: 'opencode', mode: 'supervised' }]))
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
    await settled(() => expect(frames()).toEqual([{ type: 'turn', text: 'again', mode: 'supervised' }]))
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
    type('list the files')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(frames()).toHaveLength(1))
    say(chatNotLoggedIn)
    const alert = await settled(() => screen.getByRole('alert'))
    expect(within(alert).getByRole('heading').textContent).toBe('opencode is not logged in on cachyos-g14')
    expect(alert.textContent).toContain('Run this on cachyos-g14, then retry.')
    expect(within(alert).getByText('opencode auth login')).toBeTruthy()
    expect(within(alert).getByRole('button', { name: 'Copy how to log opencode in' })).toBeTruthy()
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
    // Every turn would fail the same way until someone logs in.
    // The composer names the harness that refused, and the refused words come back.
    const composer = screen.getByLabelText<HTMLInputElement>('Message opencode in yantra-web')
    expect(composer.disabled).toBe(true)
    await settled(() => expect(composer.value).toBe('list the files'))

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

describe('permission modes', () => {
  beforeEach(() => localStorage.clear())

  async function pick(label: string) {
    fireEvent.click(screen.getByRole('button', { name: /^Permissions: / }))
    const options = await settled(() => screen.getAllByRole('menuitemradio'))
    fireEvent.click(options.find((one) => one.getAttribute('aria-label') === label)!)
    await settled(() => expect(screen.getByRole('button', { name: `Permissions: ${label}` })).toBeTruthy())
    await settled(() => expect(screen.queryByRole('menu')).toBeNull())
  }

  it('starts a new thread supervised, and sends the mode picked on the turn', async () => {
    await open()
    expect(screen.getByRole('button', { name: 'Permissions: Supervised' })).toBeTruthy()
    await pick('Full access')
    type('run the tests')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() =>
      expect(frames()).toEqual([{ type: 'turn', text: 'run the tests', harness: 'claude', mode: 'full-access' }]),
    )
  })

  it('changes the mode between turns, and the next turn carries it', async () => {
    await open()
    type('first')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    say(started())
    say(of('turn.started'))
    // A change while a turn runs holds from the next one.
    await pick('Auto-accept edits')
    say({ ...of('turn.completed'), payload: { state: 'completed', stopReason: 'end_turn' } })
    await settled(() => expect(screen.getByRole('status').textContent).toBe('Claude finished.'))
    type('second')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() =>
      expect(frames()).toEqual([
        { type: 'turn', text: 'first', harness: 'claude', mode: 'supervised' },
        { type: 'turn', text: 'second', mode: 'auto-accept-edits' },
      ]),
    )
  })

  it('keeps each thread its own mode', async () => {
    await open()
    await pick('Auto')
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalledWith('1a2b3c4d'))
    cleanup()

    render(<Chat onThread={onThread} thread="1a2b3c4d" workspace={web} />)
    await settled(() => expect(screen.getByRole('button', { name: 'Permissions: Auto' })).toBeTruthy())
    cleanup()

    render(<Chat onThread={onThread} thread="ffffffff" workspace={web} />)
    await settled(() => expect(screen.getByRole('button', { name: 'Permissions: Supervised' })).toBeTruthy())
  })

  it('falls back to Supervised when the browser refuses site data, and still sends', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      render(<Chat onThread={onThread} thread="1a2b3c4d" workspace={web} />)
      // The picker waits for the socket to open.
      await settled(() =>
        expect(screen.getByRole('button', { name: 'Permissions: Supervised' })).toHaveProperty('disabled', false),
      )
      say(started())
      await pick('Full access')
      type('go')
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await settled(() => expect(frames()).toEqual([{ type: 'turn', text: 'go', mode: 'full-access' }]))
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('draws the bad frame a daemon sends for a mode it cannot read', async () => {
    await open()
    await pick('Auto')
    type('go')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    say({ type: 'error', kind: 'badFrame', said: 'a frame is a turn, an answer, a cancel or a revert: unknown variant `auto`' })
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('The daemon could not read what the dashboard sent.')
    expect(alert.textContent).toContain('unknown variant `auto`')
    // A bad frame ends nothing: the picker still answers.
    expect(screen.getByRole('button', { name: 'Permissions: Auto' })).toHaveProperty('disabled', false)
  })
})

describe('plan mode', () => {
  const toggle = () => screen.getByRole('button', { name: /^(Plan|Build)$/ })

  it('starts in Build, toggles to Plan, and sends the plan turn', async () => {
    await open()
    expect(toggle().getAttribute('aria-label')).toBe('Build')
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-label')).toBe('Plan')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    type('plan the fix')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() =>
      expect(frames()).toEqual([
        { type: 'turn', text: 'plan the fix', harness: 'claude', mode: 'supervised', interaction: 'plan' },
      ]),
    )
  })

  it('keeps each thread its own interaction', async () => {
    await open()
    fireEvent.click(toggle())
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalledWith('1a2b3c4d'))
    cleanup()

    render(<Chat onThread={onThread} thread="1a2b3c4d" workspace={web} />)
    // Until the daemon says whose the thread is, no harness can plan.
    await settled(() => expect(server.asked).toHaveLength(2))
    await settled(() => expect(toggle().getAttribute('title')).toBe('Plan mode needs Claude'))
    say(started())
    await settled(() => expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy())
    cleanup()

    render(<Chat onThread={onThread} thread="ffffffff" workspace={web} />)
    await settled(() => expect(screen.getByRole('button', { name: 'Build' })).toBeTruthy())
  })

  it('cannot be pressed for another harness, and its turn is a build turn', async () => {
    await open()
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole('button', { name: 'Harness: Claude' }))
    const options = await settled(() => screen.getAllByRole('menuitemradio'))
    fireEvent.click(options[4])
    await settled(() => expect(screen.getByRole('button', { name: 'Harness: opencode' })).toBeTruthy())
    await settled(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(toggle()).toHaveProperty('disabled', true)
    expect(toggle().getAttribute('title')).toBe('Plan mode needs Claude')
    expect(toggle().getAttribute('aria-label')).toBe('Build')
    fireEvent.change(screen.getByLabelText('Message opencode in yantra-web'), { target: { value: 'list' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() =>
      expect(frames()).toEqual([{ type: 'turn', text: 'list', harness: 'opencode', mode: 'supervised' }]),
    )
  })

  it('draws the bad frame a daemon sends for a plan turn it refuses', async () => {
    await open()
    fireEvent.click(toggle())
    type('plan it')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    say({ type: 'error', kind: 'badFrame', said: 'plan mode needs the Claude harness' })
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('The daemon could not read what the dashboard sent.')
    expect(alert.textContent).toContain('plan mode needs the Claude harness')
    expect(toggle()).toHaveProperty('disabled', false)
  })
})

describe("Claude's model and effort", () => {
  async function pick(control: 'Model' | 'Effort', label: string) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${control}: `) }))
    const options = await settled(() => screen.getAllByRole('menuitemradio'))
    fireEvent.click(options.find((one) => one.getAttribute('aria-label') === label)!)
    await settled(() => expect(screen.getByRole('button', { name: `${control}: ${label}` })).toBeTruthy())
    await settled(() => expect(screen.queryByRole('menu')).toBeNull())
  }

  it('sends no model and no effort until they are picked, and then sends both on the turn', async () => {
    await open()
    expect(screen.getByRole('button', { name: 'Model: Default' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Effort: Default' })).toBeTruthy()
    type('first')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    say(started())
    say(of('turn.started'))
    await pick('Model', 'Opus')
    await pick('Effort', 'Extra High')
    say({ ...of('turn.completed'), payload: { state: 'completed', stopReason: 'end_turn' } })
    await settled(() => expect(screen.getByRole('status').textContent).toBe('Claude finished.'))
    type('second')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() =>
      expect(frames()).toEqual([
        { type: 'turn', text: 'first', harness: 'claude', mode: 'supervised' },
        { type: 'turn', text: 'second', mode: 'supervised', model: 'opus', effort: 'xhigh' },
      ]),
    )
  })

  it('shows neither picker on a thread another harness holds, and sends neither', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Harness: Claude' }))
    const options = await settled(() => screen.getAllByRole('menuitemradio'))
    fireEvent.click(options[4])
    await settled(() => expect(screen.getByRole('button', { name: 'Harness: opencode' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Model: / })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Effort: / })).toBeNull()
    fireEvent.change(screen.getByLabelText('Message opencode in yantra-web'), { target: { value: 'list the files' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() =>
      expect(frames()).toEqual([{ type: 'turn', text: 'list the files', harness: 'opencode', mode: 'supervised' }]),
    )
  })

  it('keeps each thread its own model and effort', async () => {
    await open()
    await pick('Model', 'Haiku')
    await pick('Effort', 'Low')
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalledWith('1a2b3c4d'))
    cleanup()

    render(<Chat onThread={onThread} thread="1a2b3c4d" workspace={web} />)
    await settled(() => expect(server.asked).toHaveLength(2))
    say(started())
    await settled(() => expect(screen.getByRole('button', { name: 'Model: Haiku' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Effort: Low' })).toBeTruthy()
    cleanup()

    render(<Chat onThread={onThread} thread="ffffffff" workspace={web} />)
    await settled(() => expect(server.asked).toHaveLength(3))
    say(started())
    await settled(() => expect(screen.getByRole('button', { name: 'Model: Default' })).toBeTruthy())
  })

  it('falls back to the default for a stored value it does not know', async () => {
    localStorage.setItem('yantra.chat.model.1a2b3c4d', 'gpt-9')
    localStorage.setItem('yantra.chat.effort.1a2b3c4d', 'ultra')
    render(<Chat onThread={onThread} thread="1a2b3c4d" workspace={web} />)
    await settled(() => expect(server.asked).toHaveLength(1))
    say(started())
    await settled(() => expect(screen.getByRole('button', { name: 'Model: Default' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Effort: Default' })).toBeTruthy()
  })
})

describe('the chat', () => {
  it('opens on an empty conversation, and says why Send is off', async () => {
    await open()
    expect(server.asked).toEqual(['/api/workspaces/yantra-web/chat'])
    await settled(() => expect(screen.getByText(/Ask Claude something about yantra-web/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Type a message to send it.')).toBeTruthy()
    // The line under the card says only a change of state, and nothing has changed yet.
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('attaches to the thread the URL names', async () => {
    await open('1a2b3c4d')
    expect(server.asked).toEqual(['/api/workspaces/yantra-web/chat?thread=1a2b3c4d'])
  })

  it('sends a turn, keeps the new thread in the URL, and streams the answer as Markdown', async () => {
    await open()
    type('run the tests')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await settled(() => expect(frames()).toEqual([{ type: 'turn', text: 'run the tests', harness: 'claude', mode: 'supervised' }]))
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

  describe('the work log', () => {
    const ended = (payload: object) => say({ ...of('turn.completed'), payload })
    const row = () => screen.getByRole('button', { name: /^(Working|Worked|You stopped)/ })

    it('keeps the running turn open on its call, then shuts to one row that opens to the call and its output', async () => {
      await open()
      say(of('turn.started'))
      say(of('item.started'))
      const log = await settled(() => screen.getByText('cargo test').closest('article')!)
      expect(row().getAttribute('aria-expanded')).toBe('true')
      expect(within(log).getByText('Command')).toBeTruthy()
      expect(within(log).getByText('running')).toBeTruthy()

      say(of('item.completed'))
      await settled(() => expect(within(log).getByText('done')).toBeTruthy())

      ended({ state: 'completed', stopReason: 'end_turn', durationMs: 4000 })
      await settled(() => expect(row().textContent).toContain('Worked for 4s'))
      expect(row().textContent).toContain('1 call')
      expect(row().getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByText('cargo test').closest('[hidden]')).not.toBeNull()

      fireEvent.click(row())
      expect(row().getAttribute('aria-expanded')).toBe('true')
      expect(row().getAttribute('aria-controls')).toBe(screen.getByText('cargo test').closest('.chat__work-body')!.id)
      expect(screen.getByText('cargo test').closest('[hidden]')).toBeNull()
      fireEvent.click(screen.getByText('Output'))
      expect(screen.getByText('test result: ok')).toBeTruthy()
    })

    it('says Worked when the agent gave no duration', async () => {
      await open()
      say(of('turn.started'))
      say(of('item.completed'))
      ended({ state: 'completed', stopReason: 'end_turn' })
      await settled(() => expect(row().textContent).toMatch(/^Worked(?! for)/))
    })

    it('says how long a stopped turn ran, or that it stopped', async () => {
      await open()
      say(of('turn.started'))
      say(of('item.completed'))
      ended({ state: 'cancelled', stopReason: 'cancelled', durationMs: 7000 })
      await settled(() => expect(row().textContent).toContain('You stopped after 7s'))

      say(of('turn.started'))
      say({ ...of('item.completed'), payload: { ...of('item.completed').payload, itemId: 'toolu_2' } })
      ended({ state: 'cancelled', stopReason: 'cancelled' })
      await settled(() => expect(screen.getByRole('button', { name: /You stopped this response/ })).toBeTruthy())
    })

    it('shows a failed call as failed inside the row', async () => {
      await open()
      say(of('turn.started'))
      say(of('item.started'))
      say({ ...of('item.completed'), payload: { ...of('item.completed').payload, status: 'failed' } })
      const log = await settled(() => screen.getByText('cargo test').closest('article')!)
      expect(within(log).getByText('failed')).toBeTruthy()
    })
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
    // The placeholder says it on screen, so the line is read out and not drawn twice.
    expect(screen.getByRole('status').classList.contains('m3-sr-only')).toBe(true)
    type('look')
    expect(screen.getByRole('status').classList.contains('m3-sr-only')).toBe(false)
    type('')

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

  it('draws the background tasks after the turn ends, stops one, stops all, and drops the list when none run', async () => {
    await open()
    type('sleep in the background')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const [running, none] = chatEvents.filter((event) => event.type === 'thread.background.updated')
    say(of('turn.started'))
    say(running)
    say(of('turn.completed'))
    const region = await settled(() => screen.getByRole('region', { name: 'Waiting on a background task' }))
    await settled(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())

    fireEvent.click(within(region).getByRole('button', { name: 'Stop Background sleep then echo completion marker' }))
    await settled(() => expect(frames()).toContainEqual({ type: 'stopTask', taskId: 'b561loltj' }))
    fireEvent.click(within(region).getByRole('button', { name: 'Stop all' }))
    await settled(() => expect(frames()).toContainEqual({ type: 'stopAll' }))
    say(none)
    await settled(() => expect(screen.queryByRole('region', { name: /background task/ })).toBeNull())
  })

  it('draws a stop the agent refused under its own heading, in its own words', async () => {
    await open()
    say(chatStopTaskFailed)
    const alert = await settled(() => screen.getByRole('alert'))
    expect(within(alert).getByRole('heading').textContent).toBe('The background task could not be stopped')
    expect(alert.textContent).toContain(chatStopTaskFailed.said)
  })

  it('shows the context the last turn used', async () => {
    await open()
    say(of('thread.token-usage.updated'))
    const ring = await settled(() => screen.getByRole('button', { name: 'Context window 15% used' }))
    fireEvent.click(ring)
    const popup = await settled(() => screen.getByRole('dialog', { name: 'Context window' }))
    expect(within(popup).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('15')
    expect(popup.textContent).toContain('29k tokens')
    expect(popup.textContent).toContain('200k tokens')
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

  it('reopens a dropped socket after the last cursor, and the turn draws on', async () => {
    await open()
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalled())
    say({ ...of('content.delta'), cursor: 'r1:812:0' })
    await settled(() => expect(screen.getByText('Running the tests.')).toBeTruthy())
    server.hangUp()
    await settled(() => expect(server.asked).toHaveLength(2))
    expect(server.asked[1]).toBe('/api/workspaces/yantra-web/chat?thread=1a2b3c4d&after=r1%3A812%3A0')
    say({ ...started(), cursor: 'r1:812:0' })
    say({ ...of('content.delta'), cursor: 'r1:900:0', payload: { ...of('content.delta').payload, delta: ' Done.' } })
    await settled(() => expect(screen.getByText('Running the tests. Done.')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('draws the thread again when the daemon starts it over', async () => {
    await open()
    say(started())
    say({ ...of('content.delta'), cursor: 'r1:812:0' })
    await settled(() => expect(screen.getByText('Running the tests.')).toBeTruthy())
    server.hangUp()
    await settled(() => expect(server.asked).toHaveLength(2))
    say(started())
    say({ ...of('content.delta'), cursor: 'r2:812:0' })
    await settled(() => expect(screen.getAllByText('Running the tests.')).toHaveLength(1))
  })

  it('draws no error while the daemon is away, and goes on when it answers', async () => {
    await open()
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalled())
    server.keepHangingUp()
    server.hangUp()
    await settled(() => expect(server.asked).toHaveLength(3))
    expect(screen.queryByRole('alert')).toBeNull()

    server.takeConnections()
    await settled(() => expect(server.asked).toHaveLength(4))
    expect(server.asked[3]).toBe('/api/workspaces/yantra-web/chat?thread=1a2b3c4d')
    await settled(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
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

describe('checkpoints', () => {
  const [diff, reverted] = chatCheckpoints

  async function aTurnChanged() {
    await open()
    say(started())
    say(diff)
    return settled(() => screen.getByRole('article', { name: 'What turn 1 changed' }))
  }

  it("draws a turn's changed files, and its diff on request", async () => {
    const card = await aTurnChanged()
    expect(within(card).getByText('Changed files')).toBeTruthy()
    expect(within(card).getByText('1')).toBeTruthy()
    const show = within(card).getByRole('button', { name: 'Diff Changed files 1' })
    expect(show.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(show)
    expect(show.getAttribute('aria-expanded')).toBe('true')
    const files = within(card).getByRole('list', { name: 'Changed files' })
    expect(within(files).getByText('a.txt')).toBeTruthy()
    const viewer = await settled(() => within(card).getByTestId('viewer'))
    expect(viewer.textContent).toContain(chatCheckpoints[0]!.payload.unifiedDiff)
    expect(viewer.getAttribute('data-quiet')).toBe('true')
    expect(within(card).queryByText('+two')).toBeNull()
    expect(within(card).getByRole('button', { name: 'Revert to before this turn' })).toBeTruthy()
    expect(within(card).queryByText('Cut at 256 KiB')).toBeNull()
  })

  it('says when a diff was cut, and draws no card for a turn that changed nothing', async () => {
    await open()
    say({ ...diff, payload: { ...diff!.payload, truncated: true } })
    say({ ...diff, payload: { turn: 2, unifiedDiff: '', truncated: false } })
    const card = await settled(() => screen.getByRole('article', { name: 'What turn 1 changed' }))
    fireEvent.click(within(card).getByRole('button', { name: /^Diff/ }))
    expect(within(card).getByText('Cut at 256 KiB')).toBeTruthy()
    expect(screen.queryByRole('article', { name: 'What turn 2 changed' })).toBeNull()
  })

  it('reverts only after the confirm, which says the conversation stays', async () => {
    const card = await aTurnChanged()
    fireEvent.click(within(card).getByRole('button', { name: 'Revert to before this turn' }))
    const dialog = await settled(() => screen.getByRole('dialog', { name: 'Revert to before turn 1?' }))
    expect(dialog.textContent).toContain('The conversation stays as it is.')
    expect(frames()).toEqual([])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Revert' }))
    await settled(() => expect(frames()).toEqual([{ type: 'revert', turn: 0 }]))
    await settled(() => expect(screen.queryByRole('dialog')).toBeNull())

    say(reverted)
    await settled(() => expect(within(card).getByText('Reverted')).toBeTruthy())
    expect(within(card).queryByRole('button', { name: 'Revert to before this turn' })).toBeNull()
  })

  it('sends nothing when the confirm is cancelled', async () => {
    const card = await aTurnChanged()
    fireEvent.click(within(card).getByRole('button', { name: 'Revert to before this turn' }))
    const dialog = await settled(() => screen.getByRole('dialog'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await settled(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(frames()).toEqual([])
  })

  it('reaches the revert by keyboard, and Escape closes the confirm without sending', async () => {
    const card = await aTurnChanged()
    const revert = within(card).getByRole('button', { name: 'Revert to before this turn' })
    expect(revert.tagName).toBe('BUTTON')
    revert.focus()
    expect(document.activeElement).toBe(revert)
    fireEvent.click(revert)
    const dialog = await settled(() => screen.getByRole('dialog', { name: 'Revert to before turn 1?' }))
    await settled(() => expect(dialog.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await settled(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(frames()).toEqual([])
  })

  it('holds the revert while a turn runs, and says why', async () => {
    const card = await aTurnChanged()
    type('and the docs')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const revert = within(card).getByRole('button', { name: 'Revert to before this turn' })
    await settled(() => expect(revert).toHaveProperty('disabled', true))
    expect(revert.getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText('A revert waits until no turn runs and the chat is connected.')).toBeTruthy()

    say({ threadId: '1a2b3c4d', type: 'turn.completed', payload: { state: 'completed', stopReason: 'end_turn' } })
    await settled(() => expect(revert).toHaveProperty('disabled', false))
  })

  it('holds the revert while the socket reopens', async () => {
    const card = await aTurnChanged()
    server.hangUp()
    await settled(() =>
      expect(within(card).getByRole('button', { name: 'Revert to before this turn' })).toHaveProperty('disabled', true),
    )
  })

  it("draws a checkpoint that failed in git's own words, and frees the composer", async () => {
    await open()
    type('fix it')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(screen.getByRole('status').textContent).toBe('Claude is answering.'))
    say(chatCheckpointFailed)
    const alert = await settled(() => screen.getByRole('alert'))
    expect(within(alert).getByRole('heading').textContent).toBe('The files could not be kept or put back')
    expect(alert.textContent).toContain("could not keep or restore this chat's files")
    expect(alert.textContent).toContain('fatal: unable to write new index file')
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
    await settled(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())
  })

  it('draws a branch diff that failed under its own heading, and the turn goes on', async () => {
    await open()
    type('fix it')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(screen.getByRole('status').textContent).toBe('Claude is answering.'))
    say(chatDiffFailed)
    const alert = await settled(() => screen.getByRole('alert'))
    expect(within(alert).getByRole('heading').textContent).toBe("The branch's changes could not be read")
    expect(alert.textContent).toContain("could not diff this chat's branch")
    expect(screen.getByRole('status').textContent).toBe('Claude is answering.')
  })
})

/** A PNG's magic and a little more, as a pasted screenshot starts. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]
const png = (name = 'shot.png') => new File([new Uint8Array(PNG)], name, { type: 'image/png' })
const images = () => server.heard.filter((frame) => 'bytes' in frame)
const turns = () => server.heard.flatMap((frame) => ('text' in frame ? [JSON.parse(frame.text)] : []))
const composerBox = () => document.querySelector<HTMLElement>('[data-slot="composer-shell"]')!
const picker = () => document.querySelector<HTMLInputElement>('input[type="file"]')!

describe('images in the composer', () => {
  let made: string[]
  let revoked: string[]

  beforeEach(() => {
    made = []
    revoked = []
    // jsdom has neither; a browser makes a `blob:` URL for the preview.
    URL.createObjectURL = (() => {
      const url = `blob:preview/${made.length + 1}`
      made.push(url)
      return url
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url)
    }
  })

  const ways = {
    button: (file: File) => {
      fireEvent.click(screen.getByRole('button', { name: 'Attach an image' }))
      fireEvent.change(picker(), { target: { files: [file] } })
    },
    paste: (file: File) => {
      fireEvent.paste(screen.getByLabelText('Message Claude in yantra-web'), { clipboardData: { files: [file] } })
    },
    drop: (file: File) => {
      fireEvent.dragOver(composerBox(), { dataTransfer: { types: ['Files'], files: [] } })
      expect(composerBox().hasAttribute('data-dropping')).toBe(true)
      expect(screen.getByText('Drop an image to attach it.')).toBeTruthy()
      fireEvent.drop(composerBox(), { dataTransfer: { types: ['Files'], files: [file] } })
      expect(composerBox().hasAttribute('data-dropping')).toBe(false)
    },
  }

  it.each(Object.keys(ways) as (keyof typeof ways)[])('takes an image by %s, with a thumbnail', async (way) => {
    await open()
    ways[way](png())
    const thumbnail = await settled(() => screen.getByRole('img', { name: 'Image 1' }))
    expect(thumbnail.getAttribute('src')).toBe('blob:preview/1')
    expect(screen.getByText('Uploading…')).toBeTruthy()
    await settled(() => expect(images()).toEqual([{ bytes: PNG }]))
    say(chatAttached)
    await settled(() => expect(screen.getByText('Attached')).toBeTruthy())
  })

  it('leaves a paste of text to the field', async () => {
    await open()
    fireEvent.paste(screen.getByLabelText('Message Claude in yantra-web'), { clipboardData: { files: [] } })
    expect(screen.queryByRole('list', { name: 'Images' })).toBeNull()
  })

  it('sends the draft with each path on a line of its own, then clears the images', async () => {
    await open()
    type('what differs?')
    ways.button(png('a.png'))
    ways.paste(png('b.png'))
    await settled(() => expect(images()).toHaveLength(2))
    say({ type: 'attached', path: '/tmp/yantra-chat-Y1/1.png' })
    say({ type: 'attached', path: '/tmp/yantra-chat-Y1/2.png' })
    await settled(() => expect(screen.getAllByText('Attached')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() =>
      expect(turns()).toEqual([
        { type: 'turn', text: 'what differs?\n/tmp/yantra-chat-Y1/1.png\n/tmp/yantra-chat-Y1/2.png', harness: 'claude', mode: 'supervised' },
      ]),
    )
    expect(screen.queryByRole('list', { name: 'Images' })).toBeNull()
    expect(revoked).toEqual(['blob:preview/1', 'blob:preview/2'])
  })

  it('sends an image with no words', async () => {
    await open()
    ways.drop(png())
    await settled(() => expect(images()).toHaveLength(1))
    say(chatAttached)
    const send = screen.getByRole('button', { name: 'Send' })
    await settled(() => expect(send).toHaveProperty('disabled', false))
    fireEvent.click(send)
    await settled(() => expect(turns()).toEqual([{ type: 'turn', text: chatAttached.path, harness: 'claude', mode: 'supervised' }]))
  })

  it('removes an image, its preview and its path', async () => {
    await open()
    ways.button(png('a.png'))
    ways.button(png('b.png'))
    await settled(() => expect(images()).toHaveLength(2))
    say({ type: 'attached', path: '/tmp/yantra-chat-Y1/1.png' })
    say({ type: 'attached', path: '/tmp/yantra-chat-Y1/2.png' })
    await settled(() => expect(screen.getAllByText('Attached')).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    expect(revoked).toEqual(['blob:preview/1'])
    expect(screen.getAllByRole('img').map((one) => one.getAttribute('src'))).toEqual(['blob:preview/2'])
    expect(screen.getByRole('img', { name: 'Image 1' })).toBeTruthy()
    type('this one')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() =>
      expect(turns()).toEqual([{ type: 'turn', text: 'this one\n/tmp/yantra-chat-Y1/2.png', harness: 'claude', mode: 'supervised' }]),
    )
  })

  it('holds Send while an image uploads, and says why', async () => {
    await open()
    type('look')
    ways.button(png())
    const send = screen.getByRole('button', { name: 'Send' })
    await settled(() => expect(send).toHaveProperty('disabled', true))
    expect(screen.getByText('An image is still uploading. Send once it is attached.')).toBeTruthy()
    fireEvent.submit(send.closest('form')!)
    expect(turns()).toEqual([])

    say(chatAttached)
    await settled(() => expect(send).toHaveProperty('disabled', false))
  })

  it('revokes every preview when the chat goes', async () => {
    await open()
    ways.button(png())
    await settled(() => expect(made).toHaveLength(1))
    cleanup()
    expect(revoked).toEqual(['blob:preview/1'])
  })

  const failures: [string, (file?: File) => void, string][] = [
    [
      'an image over 16 MiB',
      () => ways.button(new File([new Uint8Array(IMAGE_LIMIT + 1)], 'big.png', { type: 'image/png' })),
      'The image is larger than 16 MiB, the most the chat takes.',
    ],
    [
      'a file that is not an image',
      () => ways.drop(new File(['%PDF-1.7'], 'notes.pdf', { type: 'application/pdf' })),
      'The chat takes PNG, JPEG, GIF and WebP images only.',
    ],
  ]

  it.each(failures)('draws %s as failed, before anything is sent', async (_, attach, sentence) => {
    await open()
    attach()
    await settled(() => expect(screen.getByText(sentence)).toBeTruthy())
    expect(screen.getByRole('listitem').getAttribute('data-state')).toBe('failed')
    expect(images()).toEqual([])
    // A failed image holds nothing up.
    type('anyway')
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false)
  })

  it.each([
    ['bytes that are not an image', chatNotAttached, 'The chat takes PNG, JPEG, GIF and WebP images only.'],
    [
      'a machine that did not take it',
      { type: 'notAttached', kind: 'unreachable', said: 'ssh: connection reset' },
      "The workspace's machine did not take the image.",
    ],
  ])('draws %s as the daemon said it', async (_, reply, sentence) => {
    await open()
    ways.button(png())
    await settled(() => expect(images()).toHaveLength(1))
    say(reply)
    await settled(() => expect(screen.getByText(sentence)).toBeTruthy())
  })

  // The daemon removes a socket's images when it closes, so their paths name nothing.
  it('fails an attached image when its socket drops, and the reopened socket sends no path', async () => {
    await open()
    ways.button(png())
    await settled(() => expect(images()).toHaveLength(1))
    say(chatAttached)
    await settled(() => expect(screen.getByText('Attached')).toBeTruthy())
    server.hangUp()
    await settled(() =>
      expect(screen.getByText('The chat socket closed, so the image is not attached. Add it again.')).toBeTruthy(),
    )
    expect(screen.getByRole('listitem').getAttribute('data-state')).toBe('failed')

    await settled(() => expect(server.asked).toHaveLength(2))
    type('look')
    const send = screen.getByRole('button', { name: 'Send' })
    await settled(() => expect(send).toHaveProperty('disabled', false))
    fireEvent.click(send)
    await settled(() => expect(turns()).toEqual([{ type: 'turn', text: 'look', harness: 'claude', mode: 'supervised' }]))
  })

  it('fails an attached image when Try again replaces a socket the daemon left open', async () => {
    await open()
    ways.button(png())
    await settled(() => expect(images()).toHaveLength(1))
    say(chatAttached)
    await settled(() => expect(screen.getByText('Attached')).toBeTruthy())
    say({ type: 'error', kind: 'unreachable', said: 'ssh: connection reset' })
    const alert = await settled(() => screen.getByRole('alert'))
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await settled(() =>
      expect(screen.getByText('The chat socket closed, so the image is not attached. Add it again.')).toBeTruthy(),
    )
    await settled(() => expect(server.asked).toHaveLength(2))
    expect(screen.queryByText('Attached')).toBeNull()
  })

  it('gives back the words of a turn refused for its login, and not its image paths', async () => {
    await open()
    type('what is this?')
    ways.button(png())
    await settled(() => expect(images()).toHaveLength(1))
    say(chatAttached)
    await settled(() => expect(screen.getByText('Attached')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(turns()).toHaveLength(1))
    say(chatNotLoggedIn)
    const alert = await settled(() => screen.getByRole('alert'))
    const composer = screen.getByLabelText<HTMLInputElement>('Message opencode in yantra-web')
    await settled(() => expect(composer.value).toBe('what is this?'))

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await settled(() => expect(server.asked).toHaveLength(2))
    const send = screen.getByRole('button', { name: 'Send' })
    await settled(() => expect(send).toHaveProperty('disabled', false))
    fireEvent.click(send)
    await settled(() => expect(turns()).toHaveLength(2))
    expect(turns()[1].text).toBe('what is this?')
  })

  it('draws an image whose socket closed before it landed', async () => {
    await open()
    ways.button(png())
    await settled(() => expect(images()).toHaveLength(1))
    server.hangUp()
    await settled(() => expect(screen.getByText('The chat socket closed, so the image is not attached. Add it again.')).toBeTruthy())
  })
})

describe('the git actions', () => {
  const header = () => within(document.querySelector('.chat__header') as HTMLElement)
  const items = async () => {
    fireEvent.click(header().getByRole('button', { name: 'Git actions' }))
    return screen.findAllByRole('menuitem')
  }

  it('draws a quick action and a menu in the header, off until the chat has a thread', async () => {
    await open()
    expect((header().getByRole('button', { name: 'Commit' }) as HTMLButtonElement).disabled).toBe(true)
    for (const item of await items()) expect(item.getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await settled(() => expect(screen.queryByRole('menu')).toBeNull())

    say(started())
    await settled(() => expect(onThread).toHaveBeenCalled())
    // The thread has no changed files yet, so the quick action has nothing to offer; the menu does.
    await settled(() => expect(header().getByRole('button', { name: 'Up to date' })).toBeTruthy())
    await settled(async () => {
      for (const item of await items()) expect(item.getAttribute('aria-disabled')).toBeNull()
    })
  })

  it('offers Commit as the quick action once a turn has changed files', async () => {
    await open()
    say(started())
    say(chatCheckpoints[0])
    await settled(() => expect((header().getByRole('button', { name: 'Commit' }) as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('Checks and Fix with agent (Y-495)', () => {
  it('fills the composer with the failed checks and the comments, focuses it, and sends nothing', async () => {
    const url = 'https://github.com/2002Bishwajeet/yantra/pull/497'
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/threads')
          ? Response.json([{ ...threads[0], id: '1a2b3c4d', pr: { state: 'open', number: 497, url } }])
          : String(input) === '/api/pulls'
            ? Response.json({ ...pulls, data: [{ ...pulls.data[0], url, number: 497 }] })
            : new Response('no', { status: 404 }),
      ),
    )
    await open()
    say(started())
    const header = within(document.querySelector('.chat__header') as HTMLElement)
    fireEvent.click(await settled(() => header.getByRole('button', { name: 'Checks' })))
    const surface = await screen.findByRole('dialog', { name: 'Checks on PR #497' })
    const sent = server.heard.length
    fireEvent.click(await within(surface).findByRole('button', { name: 'Fix with agent' }))

    const composer = screen.getByLabelText('Message Claude in yantra-web') as HTMLTextAreaElement
    await settled(() => expect(composer.value).toMatch(/^Fix PR #497:\n\nCheck test failed \(failure\)\./))
    expect(composer.value).toContain('> src/watch.rs:L12\nThis drops the etag.')
    await settled(() => expect(document.activeElement).toBe(composer))
    expect(server.heard).toHaveLength(sent)
  })
})

describe('the branch diff', () => {
  const diffButton = () => screen.getByRole('button', { name: 'Diff' })

  it('asks the daemon, shows what it answers in place of the conversation, and puts a comment in the draft', async () => {
    await open()
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalled())
    fireEvent.click(diffButton())
    expect(diffButton().getAttribute('aria-pressed')).toBe('true')
    await settled(() => expect(frames()).toEqual([{ type: 'diff' }]))
    expect(screen.getByText('Reading the diff')).toBeTruthy()

    say({ ...chatBranchDiff, truncated: true })
    const viewer = await settled(() => screen.getByTestId('viewer'))
    expect(viewer.textContent).toContain(chatBranchDiff.unifiedDiff)
    expect(viewer.getAttribute('data-truncated')).toBe('true')
    expect(document.querySelector('.chat__turns')?.hasAttribute('hidden')).toBe(true)

    type('please look')
    fireEvent.click(screen.getByRole('button', { name: 'stub comment' }))
    const composer = screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web')
    expect(composer.value).toBe('please look\n\n> a.rs:L1\n> +x\n\nrename it\n')
    expect(frames()).toEqual([{ type: 'diff' }])

    fireEvent.click(diffButton())
    expect(screen.queryByTestId('viewer')).toBeNull()
    expect(document.activeElement).toBe(diffButton())
  })

  it('asks again on Refresh', async () => {
    await open()
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalled())
    fireEvent.click(diffButton())
    say(chatBranchDiff)
    await settled(() => screen.getByTestId('viewer'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh the diff' }))
    await settled(() => expect(frames()).toEqual([{ type: 'diff' }, { type: 'diff' }]))
  })

  it('says noThread before the first turn names a thread, and sends nothing', async () => {
    await open()
    fireEvent.click(diffButton())
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('There is no branch to compare yet')
    expect(alert.textContent).toContain('Send a first message')
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(frames()).toEqual([])
  })

  it('says notOpen when the socket is down', async () => {
    await open()
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalled())
    server.hangUp()
    await settled(() => expect(screen.getByText('The chat is not connected, so nothing can be sent.')).toBeTruthy())
    fireEvent.click(diffButton())
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('The diff could not be asked for')
  })

  it("says failed in git's own words, and keeps the daemon's error out of the conversation", async () => {
    await open()
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalled())
    fireEvent.click(diffButton())
    await settled(() => expect(frames()).toEqual([{ type: 'diff' }]))
    say(chatDiffFailed)
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('The diff could not be read')
    expect(alert.textContent).toContain(chatDiffFailed.said)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // Try again asks once more.
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await settled(() => expect(frames()).toEqual([{ type: 'diff' }, { type: 'diff' }]))
  })

  async function asked() {
    await open()
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalled())
    fireEvent.click(diffButton())
    await settled(() => expect(frames()).toEqual([{ type: 'diff' }]))
  }

  it('asks again on the socket that replaces a dropped one, and shows that reply', async () => {
    await asked()
    server.hangUp()
    await settled(() => expect(frames().filter((frame) => frame.type === 'diff')).toHaveLength(2))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Reading the diff')).toBeTruthy()
    say(chatBranchDiff)
    await settled(() => screen.getByTestId('viewer'))
  })

  it('settles on the busy a diff draws while a revert runs, and Refresh asks again', async () => {
    await asked()
    say(chatFailure)
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('The diff waits for the revert')
    expect(screen.queryByText('Reading the diff')).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh the diff' }))
    await settled(() => expect(frames().filter((frame) => frame.type === 'diff')).toHaveLength(2))
  })

  it('settles on a diff error while a turn runs, and the turn goes on', async () => {
    await asked()
    type('go')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const foot = () => document.querySelector('.composer__status')?.textContent
    await settled(() => expect(foot()).toBe('Claude is answering.'))
    say(chatDiffFailed)
    const alert = await settled(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain(chatDiffFailed.said)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(foot()).toBe('Claude is answering.')
  })

  it("leaves a client's badFrame to the conversation, and the panel keeps waiting", async () => {
    await asked()
    say({ type: 'error', kind: 'badFrame', said: 'no turn is running, so nothing is waiting' })
    await settled(() => expect(screen.getByText('The chat could not go on')).toBeTruthy())
    expect(screen.getByText('Reading the diff')).toBeTruthy()
  })

  it('leaves Refresh on while the panel waits', async () => {
    await asked()
    const refresh = screen.getByRole('button', { name: 'Refresh the diff' })
    expect(refresh.hasAttribute('disabled')).toBe(false)
    fireEvent.click(refresh)
    await settled(() => expect(frames()).toEqual([{ type: 'diff' }, { type: 'diff' }]))
  })

  it("gives a turn's checkpoint failure to the conversation, not the panel", async () => {
    await asked()
    type('go')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(frames()).toHaveLength(2))
    say(chatCheckpointFailed)
    await settled(() => expect(screen.getByText('Reading the diff')).toBeTruthy())
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain(chatCheckpointFailed.said)
  })

  it('keeps the agent’s permission request in view while the diff hides the conversation', async () => {
    await asked()
    say(of('request.opened'))
    const asking = await settled(() => screen.getByRole('region', { name: 'Waiting for your answer' }))
    expect(within(asking).getByText('Run the unit tests')).toBeTruthy()
    expect(document.querySelector('.chat__turns')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(within(asking).getByRole('button', { name: 'Accept' }))
    await settled(() => expect(frames().at(-1)).toMatchObject({ type: 'answer', requestId: 'r1' }))
  })

  it('hands the viewer one data object while the composer changes', async () => {
    await asked()
    say(chatBranchDiff)
    await settled(() => screen.getByTestId('viewer'))
    type('a')
    type('ab')
    type('abc')
    expect(new Set(seen.slice(-4)).size).toBe(1)
  })
})

const reasonOf = (name: string) =>
  document.getElementById(screen.getByRole('button', { name }).getAttribute('aria-describedby') ?? '')?.textContent

describe('the composer', () => {
  it('says why it cannot send in each state: not connected, answering, uploading and empty', async () => {
    URL.createObjectURL = (() => 'blob:preview/1') as typeof URL.createObjectURL
    URL.revokeObjectURL = () => {}
    render(<Chat onThread={onThread} workspace={web} />)
    expect(reasonOf('Send')).toBe('The chat is not connected, so nothing can be sent.')
    await settled(() => expect(server.asked).toHaveLength(1))
    await settled(() => expect(reasonOf('Send')).toBe('Type a message to send it.'))

    type('look')
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File([new Uint8Array(PNG)], 'a.png', { type: 'image/png' })] },
    })
    await settled(() => expect(reasonOf('Send')).toBe('An image is still uploading. Send once it is attached.'))
    say(chatAttached)
    await settled(() => expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false))
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('aria-describedby')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(reasonOf('Stop Claude')).toBe('Claude is answering. A message you queue is sent when it ends.'))
  })

  it('queues a message while a turn runs, with Stop and Queue together, and lists what waits', async () => {
    await open()
    type('run the tests')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    say(of('turn.started'))
    await settled(() => screen.getByRole('button', { name: 'Stop Claude' }))
    // Nothing typed: Stop alone.
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
    // The harness stays as it was while the turn runs.
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web').disabled).toBe(false)

    type('and the docs')
    expect(screen.getByRole('button', { name: 'Stop Claude' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
    await settled(() => expect(frames()).toHaveLength(2))
    expect(frames()[1]).toEqual({ type: 'turn', text: 'and the docs', harness: 'claude', mode: 'supervised' })
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web').value).toBe('')
    // The running turn keeps its state: a queued send is no new turn.
    expect(screen.getByRole('button', { name: 'Stop Claude' })).toBeTruthy()

    say(chatQueue)
    const queued = await settled(() => screen.getByRole('region', { name: 'Queued messages' }))
    expect(within(queued).getByText('Queued, sends when Claude ends')).toBeTruthy()
    expect(within(queued).getByText('and the docs')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Claude is answering. 1 message is queued.')

    say({ ...chatQueue, texts: [] })
    await settled(() => expect(screen.queryByRole('region', { name: 'Queued messages' })).toBeNull())
    expect(screen.getByRole('status').textContent).toBe('Claude is answering.')
  })

  it('puts the queued text back in an empty field when Stop drops the queue', async () => {
    await open()
    type('run the tests')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    say(of('turn.started'))
    say({ ...chatQueue, texts: ['one', 'two'] })
    await settled(() => screen.getByRole('region', { name: 'Queued messages' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop Claude' }))
    await settled(() => expect(frames()).toContainEqual({ type: 'cancel' }))
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web').value).toBe('one\n\ntwo')
    say({ ...chatQueue, texts: [] })
    await settled(() => expect(screen.queryByRole('region', { name: 'Queued messages' })).toBeNull())
  })

  it('words the empty field for each state', async () => {
    render(<Chat onThread={onThread} workspace={web} />)
    const field = screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web')
    expect(field.placeholder).toBe('Connecting to the chat…')
    await settled(() => expect(field.placeholder).toBe('Ask for changes or attach images'))
    say(started())
    say(of('turn.started'))
    say(of('request.opened'))
    await settled(() => expect(field.placeholder).toBe('Claude is waiting for your answer above'))
    server.hangUp()
    await settled(() => expect(field.placeholder).toBe('Connecting to the chat…'))
  })

  it('disables the field with its reason when the chat is closed', async () => {
    await open()
    say({ type: 'error', kind: 'unknownThread', said: 'no chat thread 1a2b3c4d' })
    const field = screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web')
    await settled(() => expect(field.disabled).toBe(true))
    expect(field.placeholder).toBe('The chat is closed.')
    expect(reasonOf('Send')).toBe('The chat is not connected, so nothing can be sent.')
  })

  it('draws the plan on the card, and the steps when it is opened', async () => {
    await open()
    expect(screen.queryByRole('button', { name: /^Plan:/ })).toBeNull()
    say({
      threadId: 't',
      type: 'turn.plan.updated',
      payload: {
        plan: [
          { step: 'Read the tests', status: 'completed' },
          { step: 'Fix the parser', status: 'inProgress' },
        ],
      },
    })
    fireEvent.click(await settled(() => screen.getByRole('button', { name: /^Plan: 1 of 2 complete/ })))
    const steps = within(screen.getByRole('list', { name: /^Plan\./ })).getAllByRole('listitem')
    expect(steps.map((one) => one.textContent)).toEqual(['Completed: Read the tests', 'Running: Fix the parser'])
  })

  it('recalls earlier prompts with ArrowUp, walks forward with ArrowDown, and leaves a typed draft alone', async () => {
    await open('1a2b3c4d')
    say(started())
    for (const [at, text] of ['first prompt', 'second prompt'].entries()) {
      say({ threadId: 't', type: 'content.delta', payload: { streamKind: 'user_text', delta: text, itemId: `user:${at}` } })
    }
    await settled(() => expect(screen.getByText('second prompt')).toBeTruthy())
    const field = screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web')
    const key = (name: string) => fireEvent.keyDown(field, { key: name })
    key('ArrowUp')
    expect(field.value).toBe('second prompt')
    key('ArrowUp')
    expect(field.value).toBe('first prompt')
    key('ArrowDown')
    expect(field.value).toBe('second prompt')
    key('ArrowDown')
    expect(field.value).toBe('')

    type('a half-written idea')
    expect(fireEvent.keyDown(field, { key: 'ArrowUp' })).toBe(true)
    expect(field.value).toBe('a half-written idea')
  })

  it('has nothing to recall in a thread with no prompts', async () => {
    await open()
    const field = screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web')
    expect(fireEvent.keyDown(field, { key: 'ArrowUp' })).toBe(true)
    expect(field.value).toBe('')
  })
})

describe('the draft', () => {
  it('is kept for the thread, comes back on a remount, and is gone after a send', async () => {
    await open()
    type('half a thought')
    cleanup()
    expect(localStorage.getItem('yantra.chat.draft.workspace/yantra-web')).toBe('half a thought')

    render(<Chat onThread={onThread} workspace={web} />)
    await settled(() => expect(server.asked).toHaveLength(2))
    await settled(() => expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false))
    const field = screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web')
    expect(field.value).toBe('half a thought')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(turns()).toHaveLength(1))
    expect(field.value).toBe('')
    cleanup()
    expect(localStorage.getItem('yantra.chat.draft.workspace/yantra-web')).toBeNull()
  })

  it('keeps each thread its own words', async () => {
    localStorage.setItem('yantra.chat.draft.1a2b3c4d', 'for this thread')
    await open('1a2b3c4d')
    say(started())
    const field = await settled(() => screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web'))
    expect(field.value).toBe('for this thread')
  })

  it('lets the issue text in only over an empty kept draft', async () => {
    localStorage.setItem('yantra.chat.draft.workspace/yantra-web', 'my own words')
    render(<Chat initialDraft="Work on o/r#1: a title" onThread={onThread} workspace={web} />)
    await settled(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web').value).toBe('my own words')
  })

  it('still sends when the browser refuses site data', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    onTestFinished(() => void vi.restoreAllMocks())
    await open()
    type('no storage')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settled(() => expect(turns()).toEqual([{ type: 'turn', text: 'no storage', harness: 'claude', mode: 'supervised' }]))
  })
})

describe('Enter in the composer', () => {
  it('sends on Enter by default on a laptop, and writes a new line with Shift', async () => {
    await open()
    type('send me')
    const field = screen.getByLabelText('Message Claude in yantra-web')
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(turns()).toEqual([])
    fireEvent.keyDown(field, { key: 'Enter' })
    await settled(() => expect(turns()).toHaveLength(1))
  })

  it('writes a new line on Enter when the setting is off, and sends on Ctrl+Enter', async () => {
    writePrefs({ general: { enterSends: false } })
    onTestFinished(() => writePrefs({ general: {} }))
    await open()
    type('send me')
    const field = screen.getByLabelText('Message Claude in yantra-web')
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(true)
    expect(turns()).toEqual([])
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    await settled(() => expect(turns()).toHaveLength(1))
  })
})

describe('a phone composer', () => {
  it('has no New line button, because Enter writes a new line there', async () => {
    browser('phone')
    await open()
    expect(screen.queryByRole('button', { name: 'New line' })).toBeNull()
    const box = screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web')
    fireEvent.change(box, { target: { value: 'first' } })
    // A phone's Enter writes a new line by default, so it sends nothing.
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(turns()).toEqual([])
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await settled(() => expect(turns()).toHaveLength(1))
  })
})

describe('@ and $ mentions (Y-562)', () => {
  const asked: { url: string; body: unknown }[] = []

  /** Answers `POST …/mentions` with `answer`, and every other read with a 404. */
  function mentionsAnswer(answer: () => Response | Promise<Response>) {
    asked.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (!url.endsWith('/mentions')) return new Response('no', { status: 404 })
        asked.push({ url, body: JSON.parse(String(init?.body)) })
        return answer()
      }),
    )
  }

  const field = () => screen.getByLabelText<HTMLTextAreaElement>('Message Claude in yantra-web')
  const key = (name: string) => fireEvent.keyDown(field(), { key: name })
  const ok = () => Response.json(aMentions())

  it('opens on @ with the files, and Enter puts the picked path in the prompt sent', async () => {
    mentionsAnswer(ok)
    await open()
    type('look at @')
    const list = await settled(() => screen.getByRole('listbox', { name: 'Files' }))
    expect(field().getAttribute('aria-expanded')).toBe('true')
    expect(field().getAttribute('aria-controls')).toBe(list.id)
    const options = within(list).getAllByRole('option')
    expect(options.map((one) => one.textContent)).toEqual(['README.md', 'src/main.rs'])
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    key('ArrowDown')
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    expect(field().getAttribute('aria-activedescendant')).toBe(options[1].id)
    key('ArrowDown')
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    key('ArrowUp')
    key('Enter')
    expect(field().value).toBe('look at @src/main.rs ')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(turns()).toEqual([])
    expect(asked).toEqual([{ url: '/api/workspaces/yantra-web/mentions', body: { harness: 'claude' } }])
    key('Enter')
    await settled(() => expect(turns()[0]?.text).toBe('look at @src/main.rs'))
  })

  it('opens on $ with the skills, and a click inserts the mention', async () => {
    mentionsAnswer(ok)
    await open()
    type('$dep')
    const list = await settled(() => screen.getByRole('listbox', { name: 'Skills' }))
    const options = within(list).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain('$deploy-staging')
    expect(options[0].textContent).toContain('Project')
    fireEvent.click(options[0])
    expect(field().value).toBe('$deploy-staging ')
    key('Enter')
    await settled(() => expect(turns()[0]?.text).toBe('$deploy-staging'))
  })

  it('takes the arrows from the prompt history while it is open', async () => {
    mentionsAnswer(ok)
    await open()
    type('@')
    await settled(() => screen.getByRole('listbox'))
    expect(key('ArrowUp')).toBe(false)
    expect(field().value).toBe('@')
  })

  it('shuts on Escape, and Enter then sends the words as typed', async () => {
    mentionsAnswer(ok)
    await open()
    type('ask @src')
    await settled(() => screen.getByRole('listbox'))
    key('Escape')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field().getAttribute('aria-expanded')).toBe('false')
    key('Enter')
    await settled(() => expect(turns()[0]?.text).toBe('ask @src'))
  })

  it('says it is searching while the answer is on its way, and that nothing matches once it comes', async () => {
    let answer: (response: Response) => void = () => {}
    mentionsAnswer(() => new Promise<Response>((resolve) => (answer = resolve)))
    await open()
    type('@zzz')
    await settled(() => expect(screen.getByText('Searching workspace files…')).toBeTruthy())
    answer(ok())
    await settled(() => expect(screen.getByText('No matching files.')).toBeTruthy())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('draws the daemon refusal, and Enter still sends', async () => {
    mentionsAnswer(() => new Response('`/srv` is not a git work tree on that machine', { status: 409 }))
    await open()
    type('@x')
    const alert = await settled(() => screen.getByRole('alert'))
    expect(within(alert).getByText('Files could not be read')).toBeTruthy()
    expect(within(alert).getByText('`/srv` is not a git work tree on that machine')).toBeTruthy()
    key('Enter')
    await settled(() => expect(turns()[0]?.text).toBe('@x'))
  })

  it('asks once while the menu stays open and the query changes', async () => {
    mentionsAnswer(ok)
    await open()
    type('@')
    await settled(() => screen.getByRole('listbox'))
    type('@s')
    type('@sr')
    type('@src/')
    key('Escape')
    type('@src/ $')
    await settled(() => screen.getByRole('listbox', { name: 'Skills' }))
    expect(asked).toHaveLength(1)
  })
})

describe('/ slash commands (Y-563)', () => {
  const asked: { url: string; body: unknown }[] = []

  /** Answers `POST …/commands` with `answer`, and every other read with a 404. */
  function commandsAnswer(answer: () => Response | Promise<Response>) {
    asked.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (!url.endsWith('/commands')) return new Response('no', { status: 404 })
        asked.push({ url, body: JSON.parse(String(init?.body)) })
        return answer()
      }),
    )
  }

  const field = (agent = 'Claude') => screen.getByLabelText<HTMLTextAreaElement>(`Message ${agent} in yantra-web`)
  const key = (name: string, agent?: string) => fireEvent.keyDown(field(agent), { key: name })
  const ok = () => Response.json(claudeCommands)
  const commandsList = () => screen.getByRole('listbox', { name: 'Commands' })

  it("opens on / with Claude's commands, the description and the hint", async () => {
    commandsAnswer(ok)
    await open()
    type('/')
    const options = await settled(() => within(commandsList()).getAllByRole('option'))
    expect(field().getAttribute('aria-expanded')).toBe('true')
    expect(field().getAttribute('aria-controls')).toBe(commandsList().id)
    expect(options.map((one) => one.textContent)).toEqual([
      '/compactFree up context by summarizing the conversation so far',
      '/reviewReview a pull request<pr>',
    ])
    expect(asked).toEqual([{ url: '/api/workspaces/yantra-web/commands', body: { harness: 'claude' } }])
  })

  it('does not open after the start of the prompt', async () => {
    commandsAnswer(ok)
    await open()
    type('see /rev')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(asked).toEqual([])
  })

  it('sends a command with no argument as it is picked', async () => {
    commandsAnswer(ok)
    await open()
    type('/com')
    await settled(() => commandsList())
    key('Enter')
    await settled(() => expect(turns()[0]?.text).toBe('/compact'))
    expect(field().value).toBe('')
  })

  it('puts a command with an argument in the prompt and waits for the argument', async () => {
    commandsAnswer(ok)
    await open()
    type('/rev')
    const options = await settled(() => within(commandsList()).getAllByRole('option'))
    fireEvent.click(options[0]!)
    expect(field().value).toBe('/review ')
    expect(turns()).toEqual([])
    expect(screen.queryByRole('listbox')).toBeNull()
    type('/review 42')
    key('Enter')
    await settled(() => expect(turns()[0]?.text).toBe('/review 42'))
  })

  it('says it is loading while the answer is on its way', async () => {
    let answer: (response: Response) => void = () => {}
    commandsAnswer(() => new Promise<Response>((resolve) => (answer = resolve)))
    await open()
    type('/zzz')
    await settled(() => expect(screen.getByText('Loading commands…')).toBeTruthy())
    answer(ok())
    await settled(() => expect(screen.getByText('No matching commands.')).toBeTruthy())
  })

  it.each([
    [409, 'claude is not on that machine: claude was not found on PATH'],
    [503, 'ssh: connect to host cachyos-g14: No route to host'],
  ])('draws a %i refusal, and Enter still sends the words', async (status, said) => {
    commandsAnswer(() => new Response(said, { status }))
    await open()
    type('/x')
    const alert = await settled(() => screen.getByRole('alert'))
    expect(within(alert).getByText('Commands could not be read')).toBeTruthy()
    expect(within(alert).getByText(said)).toBeTruthy()
    key('Enter')
    await settled(() => expect(turns()[0]?.text).toBe('/x'))
  })

  it('draws an answer it cannot read', async () => {
    commandsAnswer(() => new Response('not json', { status: 200 }))
    await open()
    type('/')
    const alert = await settled(() => screen.getByRole('alert'))
    expect(within(alert).getByText('Commands could not be read')).toBeTruthy()
  })

  it("lists an ACP agent's commands from the socket and asks the daemon nothing", async () => {
    commandsAnswer(ok)
    await open()
    say(started('opencode'))
    await settled(() => field('opencode'))
    fireEvent.change(field('opencode'), { target: { value: '/' } })
    await settled(() =>
      expect(screen.getByText('The commands appear after the agent’s first reply.')).toBeTruthy(),
    )
    say(of('thread.commands.updated'))
    const options = await settled(() => within(commandsList()).getAllByRole('option'))
    expect(options.map((one) => one.textContent)).toEqual(['/reviewreview changes<branch>'])
    key('Enter', 'opencode')
    expect(field('opencode').value).toBe('/review ')
    expect(asked).toEqual([])
  })
})

describe('markdown in a reply (Y-653)', () => {
  const reply = (delta: string) =>
    say({ threadId: '1a2b3c4d', type: 'content.delta', payload: { streamKind: 'assistant_text', delta, itemId: 'm:1' } })
  const FENCE = 'Here:\n\n```rust\nfn main() {}\n```\n'
  const clipboard = (writeText: (text: string) => Promise<void>) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  }
  const threadsAnswer = (worktree: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/threads')
          ? Response.json([{ ...threads[0], id: '1a2b3c4d', worktree }])
          : new Response('no', { status: 404 }),
      ),
    )

  it('copies the exact code from the button and says Copied', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    clipboard(writeText)
    await open()
    reply(FENCE)
    fireEvent.click(await settled(() => screen.getByRole('button', { name: 'Copy code' })))
    await settled(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith('fn main() {}')
  })

  it('selects the code and shows the hint when the clipboard refuses', async () => {
    clipboard(() => Promise.reject(new Error('insecure context')))
    await open()
    reply(FENCE)
    fireEvent.click(await settled(() => screen.getByRole('button', { name: 'Copy code' })))
    await settled(() => expect(document.querySelector('.chat__code-hint')?.textContent).toMatch(/no clipboard/))
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })

  it('draws a file in inline code as an editor link once the worktree is known', async () => {
    threadsAnswer('/wt/site')
    await open()
    say(started())
    await settled(() => expect(onThread).toHaveBeenCalledWith('1a2b3c4d'))
    reply('See `src/main.rs:12` and `foo()`.')
    const link = await settled(() => screen.getByRole('link', { name: 'Open src/main.rs in VS Code' }))
    expect(link.getAttribute('href')).toBe('vscode://vscode-remote/ssh-remote+cachyos-g14/wt/site/src/main.rs:12')
    expect(link.querySelector('code')?.textContent).toBe('src/main.rs:12')
    expect(screen.getByText('foo()').closest('a')).toBeNull()
  })

  it('leaves a path as plain code with no worktree', async () => {
    await open()
    reply('See `src/main.rs`.')
    await settled(() => expect(screen.getByText('src/main.rs')).toBeTruthy())
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('opens another link in a new tab, and renders no markdown for the user', async () => {
    await open()
    say({ threadId: '1a2b3c4d', type: 'content.delta', payload: { streamKind: 'user_text', delta: 'use **bold** `a/b.rs`', itemId: 'user:1' } })
    reply('[docs](https://example.com/x)')
    const link = await settled(() => screen.getByRole('link', { name: 'docs' }))
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
    expect(screen.getByText('use **bold** `a/b.rs`').tagName).toBe('P')
  })
})
