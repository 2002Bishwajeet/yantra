import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { mountSettings, unmountSettings } from './harness'

afterEach(() => {
  cleanup()
  unmountSettings()
})

describe('Agents', () => {
  it('counts the machines the agent is installed on, and marks the default', async () => {
    mountSettings('desktop', '/settings/agents')
    // contract.readiness carries no `agent-cli` check on either machine.
    expect(await screen.findByText(/^present on 0 of \d+ machines/)).toBeTruthy()
    expect(screen.getByText('Claude Code')).toBeTruthy()
    expect(screen.getByText('Default')).toBeTruthy()
  })

  it('says no machine is checked on a fresh install, and draws no placeholder agent', async () => {
    mountSettings('desktop', '/settings/agents', { 'GET /api/readiness': [200, { ...contract.readiness, data: [] }] })
    expect(await screen.findByText(/^no machine is checked yet · trust prompts/)).toBeTruthy()
    expect(screen.queryByText(/of 0 machines/)).toBeNull()
    expect(screen.queryByText('Another agent')).toBeNull()
    expect(screen.queryByText('Coming')).toBeNull()
  })

  /** Board group *Behaviour* is dropped: the daemon holds no switch for how an
   *  agent behaves, so the page says where the setting really lives. */
  it('says an agent behaviour is set on the machine that runs it', async () => {
    mountSettings('desktop', '/settings/agents')
    expect(await screen.findByText(/set on the machine that runs it/)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
