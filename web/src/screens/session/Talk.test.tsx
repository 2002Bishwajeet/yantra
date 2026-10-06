/**
 * The push-to-talk button (ADR-0031 §4, §6): drawn only where `doctor` found
 * `yantra-mic`, held by pointer or key, and every way a press ends drawn as
 * its own sentence. The browser's audio and socket are `test/mic.ts`'s fakes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { answer } from '@/test/daemon'
import { browser } from '@/test/mic'
import { Talk } from './Talk'

const report = (state: string | null) => ({
  looked: 'ok',
  age_seconds: 0,
  data: {
    machine: 'pi',
    checks: [
      { check: 'ssh', state: 'present', detail: 'answered' },
      ...(state ? [{ check: 'mic', state, detail: 'yantra-mic' }] : []),
    ],
  },
})

function draw(readiness: unknown = report('present'), status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      Promise.resolve(path.endsWith('/api/machines/pi/readiness') ? answer(status, readiness) : answer(404, 'no')),
    ),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Talk machine="pi" />
    </QueryClientProvider>,
  )
}

const button = () => screen.findByRole('button', { name: 'Hold to talk' })
const status = () => screen.getByRole('status')

// jsdom has no pointer capture; a browser's is what keeps a slid-off finger held.
beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('where the button is drawn', () => {
  it.each([
    ['no mic check', report(null), 200],
    ['a mic that is absent', report('absent'), 200],
    ['a mic that is unknown', report('unknown'), 200],
    ['a machine nobody has asked', 'no report', 404],
  ])('draws nothing for %s', async (_, readiness, code) => {
    browser()
    const { container } = draw(readiness, code)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await act(async () => {})
    expect(container.innerHTML).toBe('')
  })
})

describe('a press', () => {
  it('opens the microphone and the socket while held, and closes both on release', async () => {
    const fake = browser()
    draw()
    const hold = await button()
    expect(hold.getAttribute('aria-pressed')).toBe('false')

    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 })
    expect(hold.getAttribute('aria-pressed')).toBe('true')
    expect(fake.asked).toHaveBeenCalled()
    fake.allow()
    act(() => fake.socket().open())
    await waitFor(() => expect(status().textContent).toBe('Listening'))

    fireEvent.pointerUp(hold, { button: 0, pointerId: 1 })
    expect(hold.getAttribute('aria-pressed')).toBe('false')
    expect(fake.socket().closed).toBe(true)
    expect(fake.context().closed).toBe(true)
    await waitFor(() => expect(fake.track.stop).toHaveBeenCalled())
    expect(status().textContent).toBe('')
  })

  it.each([['pointerCancel'], ['lostPointerCapture'], ['blur']] as const)(
    'ends on %s',
    async (event) => {
      const fake = browser()
      draw()
      const hold = await button()
      fireEvent.pointerDown(hold, { button: 0, pointerId: 1 })
      fireEvent[event](hold, { pointerId: 1 })
      expect(fake.socket().closed).toBe(true)
      expect(hold.getAttribute('aria-pressed')).toBe('false')
    },
  )

  it.each([[' '], ['Enter']])('is held with the %j key', async (key) => {
    const fake = browser()
    draw()
    const hold = await button()
    fireEvent.keyDown(hold, { key })
    fireEvent.keyDown(hold, { key, repeat: true })
    expect(fake.asked).toHaveBeenCalledTimes(1)
    expect(hold.getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyUp(hold, { key })
    expect(fake.socket().closed).toBe(true)
    expect(hold.getAttribute('aria-pressed')).toBe('false')
  })

  it('leaves nothing open when released before the permission resolves', async () => {
    const fake = browser()
    draw()
    const hold = await button()
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 })
    fireEvent.pointerUp(hold, { button: 0, pointerId: 1 })
    expect(fake.socket().closed).toBe(true)
    fake.allow()
    await waitFor(() => expect(fake.track.stop).toHaveBeenCalled())
    expect(fake.node()).toBeUndefined()
  })
})

describe('a press that ends on its own says why', () => {
  it('is off on :7717, and says why', async () => {
    const fake = browser({ secure: false })
    draw()
    const hold = await button()
    expect(hold.hasAttribute('disabled')).toBe(true)
    const reason = document.getElementById(hold.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toBe('The microphone works only on the HTTPS address, on port 8443.')
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 })
    expect(fake.asked).not.toHaveBeenCalled()
  })

  const pressed = async (act: (fake: ReturnType<typeof browser>) => void | Promise<void>) => {
    const fake = browser()
    draw()
    const hold = await button()
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 })
    await act(fake)
    return hold
  }

  it.each([
    ['NotAllowedError', 'This browser was not allowed to use the microphone.'],
    ['NotFoundError', 'This browser found no microphone to use.'],
  ])('draws %s as its sentence', async (name, sentence) => {
    const hold = await pressed((fake) => fake.refuse(name, 'the browser said so'))
    await waitFor(() => expect(status().textContent).toContain(sentence))
    expect(status().textContent).toContain('the browser said so')
    expect(hold.getAttribute('aria-pressed')).toBe('false')
  })

  it('says the stream stopped when the browser takes the track', async () => {
    await pressed(async (fake) => {
      fake.allow()
      act(() => fake.socket().open())
      await waitFor(() => expect(fake.node()).toBeDefined())
      act(() => fake.track.end())
    })
    expect(status().textContent).toContain('The browser took the microphone away, so the stream stopped.')
  })

  it('says the daemon refused a socket that never opened', async () => {
    await pressed((fake) => act(() => fake.socket().hangUp()))
    expect(status().textContent).toContain('The daemon refused the microphone.')
  })

  it('draws the daemon’s text frame under its sentence', async () => {
    await pressed((fake) =>
      act(() => {
        fake.socket().open()
        fake.socket().say('the microphone on the machine stopped taking audio')
      }),
    )
    expect(status().textContent).toContain('The microphone on the machine stopped.')
    expect(status().textContent).toContain('the microphone on the machine stopped taking audio')
  })
})
