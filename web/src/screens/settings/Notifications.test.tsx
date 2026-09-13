import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { type Answers, mountSettings, sent, unmountSettings } from './harness'

afterEach(() => {
  cleanup()
  unmountSettings()
})

const relay = (status: number, said = ''): Answers => ({ 'POST /api/relay': [status, said] })

async function open() {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  return within(await screen.findByRole('dialog', { name: 'Push relay' }))
}

function fill(sheet: ReturnType<typeof within>, url: string, token?: string) {
  fireEvent.change(sheet.getByLabelText('Topic URL'), { target: { value: url } })
  if (token !== undefined) fireEvent.change(sheet.getByLabelText('Token'), { target: { value: token } })
  fireEvent.click(sheet.getByRole('button', { name: 'Save and send a test' }))
}

describe('the relay row', () => {
  it('reads whether the daemon holds a relay from about.relay', async () => {
    mountSettings('desktop', '/settings/notifications')
    expect(await screen.findByText('On · the daemon holds a relay and pushes to it')).toBeTruthy()
  })

  it('says off when about.relay is false', async () => {
    mountSettings('desktop', '/settings/notifications', {
      'GET /api/about': [200, { ...contract.about, relay: false }],
    })
    expect(await screen.findByText('Off · nothing is pushed')).toBeTruthy()
  })

  it('draws the boundary when the daemon answers something else', async () => {
    mountSettings('desktop', '/settings/notifications', { 'GET /api/about': [500, 'boom'] })
    expect(await screen.findByText('Notifications could not be drawn')).toBeTruthy()
  })
})

describe('the relay sheet', () => {
  it('sends the topic and the token to the one route that writes them', async () => {
    const asked = mountSettings('desktop', '/settings/notifications', {
      'POST /api/relay': (init) => {
        expect(sent(init)).toEqual({ url: 'https://ntfy.sh/a-topic', token: 'tk_notarealtoken' })
        return [204]
      },
    })
    const sheet = await open()
    fill(sheet, 'https://ntfy.sh/a-topic', 'tk_notarealtoken')
    expect(await sheet.findByText('The test message arrived at the relay.')).toBeTruthy()
    expect(asked.filter((one) => one === 'POST /api/relay')).toHaveLength(1)
    // ADR-0021: the write took, and the row says it waits on a restart.
    fireEvent.click(sheet.getByRole('button', { name: 'Done' }))
    expect(
      await screen.findByText('On · the daemon holds a relay and pushes to it · saved, used after yantrad restarts'),
    ).toBeTruthy()
  })

  /** An open topic and a topic with a blank password are not the same thing,
   *  and an empty string would be written into the file as the second. */
  it('omits the token rather than sending an empty one', async () => {
    mountSettings('desktop', '/settings/notifications', {
      'POST /api/relay': (init) => {
        expect(sent(init)).toEqual({ url: 'https://ntfy.sh/a-topic' })
        return [204]
      },
    })
    const sheet = await open()
    fill(sheet, 'https://ntfy.sh/a-topic')
    expect(await sheet.findByText('The test message arrived at the relay.')).toBeTruthy()
  })

  /** The daemon writes before it sends, so a 502 is not a failed save — the
   *  row still counts it as saved. */
  it('says a 502 wrote the relay, and the row still counts it saved', async () => {
    mountSettings(
      'desktop',
      '/settings/notifications',
      relay(502, 'the relay is written down in /etc/yantra/daemon.env, and the test message did not arrive: the relay answered 401'),
    )
    const sheet = await open()
    fill(sheet, 'https://ntfy.sh/a-topic', 'tk_wrong')
    expect(await sheet.findByText('The relay is written down, and the test message did not arrive.')).toBeTruthy()
    expect(sheet.getByText(/answered 401/)).toBeTruthy()
    fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
    expect(
      await screen.findByText('On · the daemon holds a relay and pushes to it · saved, used after yantrad restarts'),
    ).toBeTruthy()
  })

  it("draws a refusal with the daemon's own words, and the row says nothing was saved", async () => {
    mountSettings('desktop', '/settings/notifications', relay(403, 'node biswas-iphone is on this tailnet but is not yours'))
    const sheet = await open()
    fill(sheet, 'https://ntfy.sh/a-topic')
    expect(await sheet.findByText("This browser is not on a node this tailnet's owner holds.")).toBeTruthy()
    expect(sheet.getByText('node biswas-iphone is on this tailnet but is not yours')).toBeTruthy()
    // Not written: the row still reads the daemon it started with.
    fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('On · the daemon holds a relay and pushes to it')).toBeTruthy()
  })

  /** The daemon decides what is worth a push and no route changes it, so the
   *  rows read the daemon rather than set it (D7 §4.7: a value, not a switch
   *  that looks broken while disabled). */
  it('draws what the daemon pushes as values nothing here can move', async () => {
    mountSettings('desktop', '/settings/notifications')
    await screen.findByRole('button', { name: 'Edit' })
    const row = (headline: string) => screen.getByText(headline).closest('li')!
    expect(within(row('When an agent needs you')).getByText('Sent')).toBeTruthy()
    expect(within(row('When a session ends')).getByText('Sent')).toBeTruthy()
    // I-47: a look the daemon could not make is not a change it can report.
    expect(within(row('When a machine goes unreachable')).getByText('Not sent')).toBeTruthy()
    expect(within(row('Quiet while a dashboard is open')).getByText('Always')).toBeTruthy()
    expect(screen.getByText(/there is no route that changes this/)).toBeTruthy()
  })

  it('masks the token until Show is pressed', async () => {
    mountSettings('desktop', '/settings/notifications')
    const sheet = await open()
    const token = sheet.getByLabelText('Token') as HTMLInputElement
    expect(token.type).toBe('password')
    fireEvent.click(sheet.getByRole('button', { name: 'Show token' }))
    expect(token.type).toBe('text')
  })

  /** §B4 holds everywhere ADR-0021 did not carve: nothing reads a relay back,
   *  so the page cannot put a token on the wire in the other direction. */
  it('reads no relay from the daemon when it opens', async () => {
    const asked = mountSettings('desktop', '/settings/notifications')
    await screen.findByRole('button', { name: 'Edit' })
    await waitFor(() => expect(asked).toContain('POST /api/viewing'))
    expect(asked.filter((one) => one.includes('/api/relay'))).toHaveLength(0)
  })
})
