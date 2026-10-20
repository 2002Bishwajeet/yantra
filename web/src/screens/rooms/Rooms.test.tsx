/**
 * `/rooms` and `/rooms/$room` (Y-536, ADR-0038 decisions 4 and 5): the owner
 * sees the rooms, reads one, posts into it and resumes it. The daemon owns
 * every rule and `mcp.rs` tests them; this asserts the page draws each answer,
 * every refusal included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import type { Room as RoomData, RoomSummary } from '@/api'
import { makeQueryClient } from '@/api/client'
import { read } from '@/m3/live/live'
import { Room } from './Room'
import { Rooms } from './Rooms'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

beforeEach(() => vi.stubGlobal('scrollTo', () => {}))

const NOW = 1_800_000_000

const design: RoomSummary = {
  name: 'design',
  spent: 3,
  budget: 20,
  paused: false,
  members: 2,
  messages: 1,
  last_at: NOW - 60,
}
const review: RoomSummary = { ...design, name: 'review', spent: 20, paused: true, messages: 2 }

const reviewRoom: RoomData = {
  ...review,
  log: [
    { seq: 19, at: NOW - 120, from: 'alpha · chat A1', text: 'The API is ready.', budget: 19 },
    { seq: 20, at: NOW - 60, from: 'beta', text: '<b>bold?</b>\nline two', budget: 20 },
  ],
}

type Answer = { status: number; body: unknown }
type Calls = { method: string; path: string; body?: string }[]

/** Answers by `METHOD path`; anything unlisted is the daemon's 404. */
function daemon(answers: Record<string, Answer | (() => Answer)>) {
  const calls: Calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, path, body: init?.body ? String(init.body) : undefined })
      const found = answers[`${method} ${path}`]
      const answer = (typeof found === 'function' ? found() : found) ?? {
        status: 404,
        body: `no room ${path}`,
      }
      const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
      return Promise.resolve({
        ok: answer.status < 400,
        status: answer.status,
        json: () => Promise.resolve(answer.body),
        text: () => Promise.resolve(text),
      })
    }),
  )
  return calls
}

function open(path: string) {
  vi.setSystemTime(NOW * 1000)
  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/rooms', component: Rooms }),
      createRoute({ getParentRoute: () => root, path: '/rooms/$room', component: Room }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('the rooms list', () => {
  it('shows each room with its budget, members and pause, and links to it', async () => {
    daemon({ 'GET /api/rooms': { status: 200, body: [design, review] } })
    open('/rooms')
    const link = await screen.findByRole('link', { name: /review/ })
    expect(link.getAttribute('href')).toBe('/rooms/review')
    expect(link.textContent).toContain('20/20 · 2 members · 2 messages')
    expect(link.textContent).toContain('paused')
    const other = screen.getByRole('link', { name: /design/ })
    expect(other.textContent).toContain('3/20 · 2 members · 1 message')
    expect(other.textContent).not.toContain('paused')
  })

  it('says there is no room, and why, when the daemon holds none', async () => {
    daemon({ 'GET /api/rooms': { status: 200, body: [] } })
    open('/rooms')
    expect(await screen.findByText('No rooms')).toBeTruthy()
    expect(screen.getByText(/a restart clears them/)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('draws a refusal of the list as an error, with the daemon’s words', async () => {
    daemon({ 'GET /api/rooms': { status: 403, body: 'node n1 is on this tailnet but is not yours' } })
    open('/rooms')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('The rooms could not be read')).toBeTruthy()
    expect(alert.textContent).toContain('not yours')
  })

  it('draws a body that is not a list as a contract error', async () => {
    daemon({ 'GET /api/rooms': { status: 200, body: { looked: 'never' } } })
    open('/rooms')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('cannot read')
  })
})

describe('one room', () => {
  it('shows every message as plain text with its label and age', async () => {
    daemon({ 'GET /api/rooms/review': { status: 200, body: reviewRoom } })
    open('/rooms/review')
    const log = await screen.findByRole('list', { name: 'Messages' })
    const items = within(log).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('alpha · chat A1')
    expect(items[0]!.textContent).toContain('2m')
    expect(items[1]!.querySelector('b')).toBeNull()
    expect(items[1]!.textContent).toContain('<b>bold?</b>')
  })

  it('a room the daemon does not hold is named, with a way back', async () => {
    daemon({})
    open('/rooms/gone')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('No room is called gone')).toBeTruthy()
    expect(alert.textContent).toContain('a restart clears them')
    expect(within(alert).getByRole('link', { name: 'All rooms' }).getAttribute('href')).toBe('/rooms')
  })

  it('a paused room has a banner, and Resume lifts it and says so', async () => {
    let paused = true
    const calls = daemon({
      'GET /api/rooms/review': () => ({
        status: 200,
        body: paused ? reviewRoom : { ...reviewRoom, paused: false, spent: 0 },
      }),
      'POST /api/rooms/review/resume': () => {
        paused = false
        return { status: 204, body: '' }
      },
    })
    open('/rooms/review')
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull())
    expect(screen.getByText(/0\/20/)).toBeTruthy()
    expect(read().text).toBe('Room review resumed.')
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/rooms/review/resume')).toBe(true)
  })

  it('a failed resume is drawn beside the button, and the banner stays', async () => {
    daemon({
      'GET /api/rooms/review': { status: 200, body: reviewRoom },
      'POST /api/rooms/review/resume': { status: 404, body: 'no room review: it was never made, or yantrad has restarted since' },
    })
    open('/rooms/review')
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('The room was not resumed')).toBeTruthy()
    expect(alert.textContent).toContain('restarted since')
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
  })

  it('a post sends the text, clears the box, refreshes the room and announces who sees it', async () => {
    let posted = false
    const after: RoomData = {
      ...reviewRoom,
      paused: false,
      spent: 0,
      log: [...reviewRoom.log, { seq: 21, at: NOW, from: 'owner on pixel', text: 'Go ahead.', budget: 0 }],
    }
    const calls = daemon({
      'GET /api/rooms/review': () => ({ status: 200, body: posted ? after : reviewRoom }),
      'POST /api/rooms/review/messages': () => {
        posted = true
        return { status: 200, body: { seq: 21, delivered: 2 } }
      },
    })
    open('/rooms/review')
    const box = await screen.findByLabelText('Message')
    fireEvent.change(box, { target: { value: 'Go ahead.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    expect(await screen.findByText('Go ahead.')).toBeTruthy()
    expect(screen.getByText('owner on pixel')).toBeTruthy()
    expect((box as HTMLInputElement).value).toBe('')
    expect(read().text).toBe('Posted to review. 2 members see it.')
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    const post = calls.find((c) => c.method === 'POST')
    expect(JSON.parse(post!.body!)).toEqual({ text: 'Go ahead.' })
  })

  it('an empty box sends nothing', async () => {
    const calls = daemon({ 'GET /api/rooms/review': { status: 200, body: reviewRoom } })
    open('/rooms/review')
    fireEvent.click(await screen.findByRole('button', { name: 'Post' }))
    await new Promise((done) => setTimeout(done, 10))
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it.each([
    [400, 'a message is at most 16 KiB, and this one is 16385 bytes', 'The daemon would not take what was sent.'],
    [403, 'node n1 is on this tailnet but is not yours', "This browser is not on a node this tailnet's owner holds."],
    [404, 'no room review: it was never made, or yantrad has restarted since', 'The daemon knows nothing by that name.'],
  ])('a post refused with %i keeps the text and draws the refusal', async (status, said, sentence) => {
    daemon({
      'GET /api/rooms/review': { status: 200, body: reviewRoom },
      'POST /api/rooms/review/messages': { status, body: said },
    })
    open('/rooms/review')
    const box = await screen.findByLabelText('Message')
    fireEvent.change(box, { target: { value: 'too much' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('The message was not posted')).toBeTruthy()
    expect(alert.textContent).toContain(sentence)
    expect(alert.textContent).toContain(said)
    expect((box as HTMLInputElement).value).toBe('too much')
  })

  it('a post the network drops says the daemon did not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_path: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(reviewRoom),
              text: () => Promise.resolve(JSON.stringify(reviewRoom)),
            }),
      ),
    )
    open('/rooms/review')
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The daemon did not answer.')
  })
})
