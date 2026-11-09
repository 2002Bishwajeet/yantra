/**
 * Y-644: the Terminal's History names whose turns it holds, and prints no
 * session id.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import { aWorkspace } from '@/api/fixtures'
import type { Said } from '@/api/hooks'
import { renderRouted } from '@/test/inRouter'
import { Transcript } from './Transcript'

const workspace = aWorkspace()

const draw = (said: Said) =>
  renderRouted(<Transcript now={Date.now()} onRead={() => {}} said={said} state={null} workspace={workspace} />)

afterEach(cleanup)

describe('the transcript with no turn in it', () => {
  it('says it holds the Terminal agent only, and drops the session id the daemon sent', async () => {
    await draw({
      said: 'nothing',
      because:
        'the agent in `/home/<user>/Github/homelab/yantra` has written no turn yet — its transcript appears on its first message, not when it launches (session d4c3b2a1-0f9e-4d8c-b7a6-5e4d3c2b1a09)',
    })

    expect(await screen.findByText(/The agent in the Terminal has not written a turn\. .*Chat turns are not here\./)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('still draws a refusal, with what ssh said', async () => {
    await draw({ said: 'refused', status: 502, because: 'ssh: connect to host cachyos-g14 port 22: Connection refused' })

    expect(await screen.findByText('The transcript could not be read')).toBeTruthy()
    expect(screen.getByText(/Connection refused/)).toBeTruthy()
  })
})
