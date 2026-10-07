/**
 * The Chat view against a real WebSocket server (`harness.ts`). The daemon's
 * side is played from `contract.gen.ts`, which is what `yantrad` really
 * serialises, and every frame asserted below crossed a socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Workspace } from '@/api'
import type { Harness, ThreadEvent } from '@/api/thread'
import { IMAGE_LIMIT } from '@/api/chat'
import { chatAttached, chatEvents, chatNotAttached, chatNotLoggedIn } from '@/contract.gen'
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

/** A PNG's magic and a little more, as a pasted screenshot starts. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]
const png = (name = 'shot.png') => new File([new Uint8Array(PNG)], name, { type: 'image/png' })
const images = () => server.heard.filter((frame) => 'bytes' in frame)
const turns = () => server.heard.flatMap((frame) => ('text' in frame ? [JSON.parse(frame.text)] : []))
const composerBox = () => document.querySelector<HTMLElement>('.chat__composer')!
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
        { type: 'turn', text: 'what differs?\n/tmp/yantra-chat-Y1/1.png\n/tmp/yantra-chat-Y1/2.png', harness: 'claude' },
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
    await settled(() => expect(turns()).toEqual([{ type: 'turn', text: chatAttached.path, harness: 'claude' }]))
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
      expect(turns()).toEqual([{ type: 'turn', text: 'this one\n/tmp/yantra-chat-Y1/2.png', harness: 'claude' }]),
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
  it('fails an attached image when its socket closes, and Try again sends no path', async () => {
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

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }))
    await settled(() => expect(server.asked).toHaveLength(2))
    type('look')
    const send = screen.getByRole('button', { name: 'Send' })
    await settled(() => expect(send).toHaveProperty('disabled', false))
    fireEvent.click(send)
    await settled(() => expect(turns()).toEqual([{ type: 'turn', text: 'look', harness: 'claude' }]))
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
