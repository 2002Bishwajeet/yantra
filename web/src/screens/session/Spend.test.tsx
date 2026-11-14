/**
 * Y-644: the Spend tab names what it counts, and prints no transcript path and
 * no session id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { aWorkspace } from '@/api/fixtures'
import type { Asked } from '@/lib/spend'
import { renderRouted } from '@/test/inRouter'
import { Spend } from './Spend'

const workspace = aWorkspace()
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/
const SCOPE = /^Read over ssh from the Terminal agent's transcript on .+, only when you ask; chat turns and other workspaces are not counted\.$/

const draw = (asked: Asked) =>
  renderRouted(<Spend asked={asked} now={Date.parse('2026-11-09T10:00:00Z')} onAsk={() => {}} workspace={workspace} />)

// The hero reads the form factor; jsdom has no `matchMedia`. `matches: true` is a desktop.
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the Spend tab', () => {
  it('says it counts the Terminal agent only, and prints no transcript path', async () => {
    await draw({ asked: 'read', workspace, spend: contract.spend, at: '2026-11-09T09:59:00Z' })

    await screen.findByRole('button', { name: 'Read spend' })
    const note = document.querySelector('.spend__note')!
    expect(note.textContent).toMatch(SCOPE)
    expect(note.textContent).toContain(workspace.machine)
    expect(document.body.textContent).not.toContain('.jsonl')
    expect(document.body.textContent).not.toMatch(UUID)
    expect(document.body.textContent).not.toContain('Nothing polls it')
    expect(document.body.textContent).not.toContain('There is no fleet total')
  })

  it('sets the figure in the display type scale, with a Read spend button beside the read age', async () => {
    await draw({ asked: 'read', workspace, spend: contract.spend, at: '2026-11-09T09:59:00Z' })

    await screen.findByRole('button', { name: 'Read spend' })
    const figure = document.querySelector('.spend__number')!
    expect(figure.getAttribute('data-scale')).toBe('display-large')
    expect(figure.classList.contains('m3-mono')).toBe(false)
    expect(figure.classList.contains('m3-num')).toBe(true)
    const button = screen.getByRole('button', { name: 'Read spend' })
    expect(button.getAttribute('data-variant')).toBe('tonal')
    expect(button.parentElement!.querySelector('time')!.textContent).toBe('1m')
  })

  it('names the Terminal agent when there is nothing, and drops the session id the daemon sent', async () => {
    await draw({
      asked: 'nothing',
      workspace,
      said: 'the agent in `/home/<user>/Github/homelab/yantra` has written no turn yet — its transcript appears on its first message, not when it launches (session d4c3b2a1-0f9e-4d8c-b7a6-5e4d3c2b1a09)',
    })

    expect(await screen.findByText('There is nothing to add up yet.')).toBeTruthy()
    expect(screen.getByText(/The agent in the Terminal has not written a turn\./)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Read spend' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(UUID)
  })

  it('still draws a refusal, with what ssh said', async () => {
    await draw({ asked: 'refused', workspace, status: 502, said: 'ssh: connect to host cachyos-g14 port 22: Connection refused' })

    expect(await screen.findByText('The spend could not be read')).toBeTruthy()
    expect(screen.getByText(/Connection refused/)).toBeTruthy()
  })
})
