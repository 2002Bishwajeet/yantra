/**
 * The composer's hold-to-dictate (ADR-0043 §4, §6): hidden while dictation is
 * off, disabled with its reason while the box does not answer, and held by
 * pointer or key. The browser's audio and socket are `test/mic.ts`'s fakes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { answer } from '@/test/daemon'
import { browser } from '@/test/mic'
import { DictateButton } from './Dictate'
import { dictationStatus, useDictation } from './useDictation'

function Harness({ onText }: { onText: (text: string) => void }) {
  const dictation = useDictation({ workspace: 'site', thread: 't1', onText })
  return (
    <>
      <DictateButton describedBy="said" dictation={dictation} />
      <p id="said" role="status">
        {dictationStatus(dictation)}
      </p>
    </>
  )
}

function draw(health: unknown, status = 200) {
  const asked = vi.fn((_path: string) => Promise.resolve(answer(status, health)))
  vi.stubGlobal('fetch', asked)
  const onText = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Harness onText={onText} />
    </QueryClientProvider>,
  )
  return { asked, onText }
}

const button = () => screen.findByRole('button', { name: 'Hold to dictate' })

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('where the button is drawn', () => {
  it('draws nothing while dictation is off, or before the daemon answers', async () => {
    browser()
    const { asked } = draw({ state: 'off' })
    await waitFor(() => expect(asked).toHaveBeenCalledWith('/api/dictate/health', expect.anything()))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('draws nothing when the health read fails', async () => {
    browser()
    const { asked } = draw('boom', 500)
    await waitFor(() => expect(asked).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('is disabled and says why while the box does not answer', async () => {
    browser()
    draw({ state: 'unreachable' })
    expect((await button()).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe(
      'Dictation is off: yantra-box does not answer. Press to ask again.',
    )
  })

  it('is disabled on a page that is not a secure context', async () => {
    browser({ secure: false })
    draw({ state: 'ready' })
    expect((await button()).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('The microphone works only on the HTTPS address')
  })
})

describe('one hold', () => {
  it('records while held, sends end on release, and hands the words over', async () => {
    const fake = browser()
    const { onText } = draw({ state: 'ready' })
    const held = await button()
    expect(held.getAttribute('aria-pressed')).toBe('false')

    fireEvent.pointerDown(held, { button: 0, pointerId: 1 })
    expect(held.getAttribute('aria-pressed')).toBe('true')
    expect(fake.socket().url).toMatch(/\/api\/dictate\?workspace=site&thread=t1$/)
    fake.allow()
    act(() => fake.socket().open())
    await waitFor(() => expect(fake.node()).toBeDefined())
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Listening'))

    fireEvent.pointerUp(held, { pointerId: 1 })
    expect(fake.socket().sent.at(-1)).toBe('end')
    await waitFor(() => expect(held.getAttribute('aria-busy')).toBe('true'))
    expect(screen.getByRole('status').textContent).toContain('Writing down what you said')

    act(() => fake.socket().say(JSON.stringify({ text: 'use tokio' })))
    expect(onText).toHaveBeenCalledWith('use tokio')
    await waitFor(() => expect(held.getAttribute('aria-busy')).toBe('false'))
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('is held by Space too', async () => {
    const fake = browser()
    draw({ state: 'ready' })
    const held = await button()
    fireEvent.keyDown(held, { key: ' ' })
    expect(held.getAttribute('aria-pressed')).toBe('true')
    fake.allow()
    act(() => fake.socket().open())
    await waitFor(() => expect(fake.node()).toBeDefined())
    fireEvent.keyUp(held, { key: ' ' })
    expect(fake.socket().sent.at(-1)).toBe('end')
  })

  it.each([
    ['silent', 'No words were heard.', false],
    ['too-long', 'That was over 60 seconds', false],
    ['failed', 'The speech service failed', true],
    ['unreachable', 'Dictation is off: yantra-box does not answer.', true],
  ])('says %s in its own words, and asks the health again only when the service may be gone', async (error, sentence, again) => {
    const fake = browser()
    const { asked, onText } = draw({ state: 'ready' })
    const held = await button()
    fireEvent.pointerDown(held, { button: 0, pointerId: 1 })
    fake.allow()
    act(() => fake.socket().open())
    await waitFor(() => expect(fake.node()).toBeDefined())
    fireEvent.pointerUp(held, { pointerId: 1 })
    act(() => fake.socket().say(JSON.stringify({ error, said: 'why' })))

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(sentence))
    expect(onText).not.toHaveBeenCalled()
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(again ? 2 : 1))
  })
})

describe('when the box comes back', () => {
  function healths(...states: string[]) {
    const asked = vi.fn((_path: string) => Promise.resolve(answer(200, { state: states.shift() ?? 'ready' })))
    vi.stubGlobal('fetch', asked)
    return asked
  }
  const mount = (client: QueryClient) =>
    render(
      <QueryClientProvider client={client}>
        <Harness onText={vi.fn()} />
      </QueryClientProvider>,
    )

  it('asks again on a press, and the button can then be held', async () => {
    const fake = browser()
    const asked = healths('unreachable', 'ready')
    mount(new QueryClient())
    const held = await button()
    expect(held.getAttribute('aria-disabled')).toBe('true')

    fireEvent.pointerDown(held, { button: 0, pointerId: 1 })
    fireEvent.pointerUp(held, { pointerId: 1 })
    expect(fake.socket()).toBeUndefined()
    await waitFor(() => expect(held.hasAttribute('aria-disabled')).toBe(false))
    expect(asked).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toBe('')

    fireEvent.pointerDown(held, { button: 0, pointerId: 2 })
    expect(fake.socket().url).toMatch(/\/api\/dictate\?workspace=site&thread=t1$/)
  })

  it('asks again by key too', async () => {
    browser()
    const asked = healths('unreachable', 'ready')
    mount(new QueryClient())
    const held = await button()
    fireEvent.keyDown(held, { key: 'Enter' })
    await waitFor(() => expect(held.hasAttribute('aria-disabled')).toBe(false))
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('asks again each time the Chat opens, so a cached unreachable does not stick', async () => {
    browser()
    const asked = healths('unreachable', 'ready')
    const client = new QueryClient()
    const first = mount(client)
    expect((await button()).getAttribute('aria-disabled')).toBe('true')
    first.unmount()

    mount(client)
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(2))
    await waitFor(async () => expect((await button()).hasAttribute('aria-disabled')).toBe(false))
  })
})
