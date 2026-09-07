import { describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import type { AgentState, Looked, WorkspaceStatus } from '@/api'
import { keys } from '@/api/keys'
import { StatusAnnouncer } from './Announce'

const reached = (status: AgentState): Looked<WorkspaceStatus> => ({
  looked: 'ok',
  age_seconds: 0,
  data: { workspace: 'api', machine: 'cachyos-g14', reached: 'yes', status, session: null },
})

function announcing() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <StatusAnnouncer />
    </QueryClientProvider>,
  )
  const region = document.querySelector('[aria-live="polite"]')!
  const say = (status: AgentState) =>
    act(() => client.setQueryData(keys.status('api'), reached(status)))
  return { region, say }
}

describe('the status announcer', () => {
  it('says nothing about the first reading, which is the list rather than a change', () => {
    const { region, say } = announcing()
    say({ state: 'running' })
    expect(region.textContent).toBe('')
  })

  it('announces the transition a poll made, and names the workspace', () => {
    const { region, say } = announcing()
    say({ state: 'running' })
    say({ state: 'crashed', exit_status: 1 })
    expect(region.textContent).toBe('api is crashed, exit 1.')
  })

  /** A poll that answers the same thing is the ordinary case, and a region
   *  that repeated it would say every session's state every five seconds. */
  it('says nothing when a poll answers what the last one did', () => {
    const { region, say } = announcing()
    say({ state: 'running' })
    say({ state: 'crashed', exit_status: 1 })
    say({ state: 'crashed', exit_status: 1 })
    expect(region.textContent).toBe('api is crashed, exit 1.')
  })

  it('is a live region rather than one more thing named status', () => {
    announcing()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
