import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { answer } from '@/test/daemon'
import { renderInApp } from '@/test/inApp'
import { ThreadList } from './ThreadList'
import { groupThreads, prMark } from './threads'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function daemon(...replies: [number, unknown][]) {
  const asked: string[] = []
  let at = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      const [status, body] = replies[Math.min(at++, replies.length - 1)]!
      return Promise.resolve(answer(status, body))
    }),
  )
  return asked
}

const show = (thread?: string) => renderInApp(<ThreadList name="site" thread={thread} view="chat" />)

describe('prMark', () => {
  it('names each of the five states', () => {
    expect(contract.threads.map((one) => prMark(one.pr).word)).toEqual([
      'no PR',
      'PR #512 open',
      'PR #511 closed',
      'PR #510 merged',
      'PR unknown',
    ])
  })

  it('groups what is still going apart from what is done', () => {
    expect(groupThreads(contract.threads).map((one) => [one.title, one.items.length])).toEqual([
      ['Active', 3],
      ['Finished', 2],
    ])
  })
})

describe('the thread list', () => {
  it('reads once on mount and draws branch, issue and PR for each thread', async () => {
    const asked = daemon([200, contract.threads])
    await show('1a1b2c3d4e5f6a7b')
    const rows = await screen.findAllByRole('link')
    expect(rows).toHaveLength(5)
    expect(asked).toEqual(['POST /api/workspaces/site/threads'])
    const open = rows[1]!
    expect(within(open).getByText('1a1b2c3d4e5f6a7b')).toBeTruthy()
    expect(within(open).getByText('2002Bishwajeet/yantra#488')).toBeTruthy()
    expect(within(open).getByText('PR #512 open')).toBeTruthy()
    expect(screen.getByText('PR #510 merged')).toBeTruthy()
    expect(screen.getByText('PR #511 closed')).toBeTruthy()
    expect(screen.getByText('no PR')).toBeTruthy()
  })

  it('links each row to its thread with the current one marked', async () => {
    daemon([200, contract.threads])
    await show('1a1b2c3d4e5f6a7b')
    const rows = await screen.findAllByRole('link')
    expect(rows.map((one) => one.getAttribute('href'))).toContain('/w/site?view=chat&thread=1a1b2c3d4e5f6a7b')
    const current = rows.filter((one) => one.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
    expect(current[0]!.getAttribute('href')).toContain('thread=1a1b2c3d4e5f6a7b')
  })

  it('shows an unknown PR with its reason and keeps the list', async () => {
    daemon([200, contract.threads])
    await show()
    expect(await screen.findByText('no GitHub grant — run `yantra github login`')).toBeTruthy()
    expect(screen.getAllByRole('link')).toHaveLength(5)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('asks again on Refresh', async () => {
    const asked = daemon([200, []], [200, contract.threads])
    await show()
    expect(await screen.findByText(/No threads yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(5))
    expect(asked).toEqual(['POST /api/workspaces/site/threads', 'POST /api/workspaces/site/threads'])
  })

  it('draws a pending state while the read is out', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = await show()
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeTruthy())
  })

  it('fails in place with the daemon words and a way to retry', async () => {
    const asked = daemon([503, 'ssh to cachyos-g14 timed out'], [200, contract.threads])
    await show()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The threads could not be listed')
    expect(alert.textContent).toContain('ssh to cachyos-g14 timed out')
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(5))
    expect(asked).toHaveLength(2)
  })
})
