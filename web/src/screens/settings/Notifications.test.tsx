import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
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
    // The row reads back what this page wrote, since nothing else can.
    fireEvent.click(sheet.getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('ntfy.sh · Set · replaced just now')).toBeTruthy()
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

  /** The daemon writes before it sends, so a 502 is not a failed save — and a
   *  page that says "failed" has someone type it all in again. */
  it('says a 502 wrote the relay and did not deliver the message', async () => {
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
    expect(await screen.findByText('ntfy.sh · Set · replaced just now · the test message did not arrive')).toBeTruthy()
  })

  it("draws a refusal with the daemon's own words", async () => {
    mountSettings('desktop', '/settings/notifications', relay(403, 'node biswas-iphone is on this tailnet but is not yours'))
    const sheet = await open()
    fill(sheet, 'https://ntfy.sh/a-topic')
    expect(await sheet.findByText("This browser is not on a node this tailnet's owner holds.")).toBeTruthy()
    expect(sheet.getByText('node biswas-iphone is on this tailnet but is not yours')).toBeTruthy()
    // Not written: the row still says so.
    fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText(/nothing is read back/)).toBeTruthy()
  })

  /** The daemon decides what is worth a push and no route changes it, so the
   *  switches read the daemon rather than set it. */
  it('draws what the daemon pushes as switches the page cannot move', async () => {
    mountSettings('desktop', '/settings/notifications')
    await screen.findByRole('button', { name: 'Edit' })
    const needs = screen.getByRole('switch', { name: 'When an agent needs you' })
    expect(needs.getAttribute('aria-checked')).toBe('true')
    expect((needs as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('switch', { name: 'When a session ends' }).getAttribute('aria-checked')).toBe('true')
    // I-47: a look the daemon could not make is not a change it can report.
    expect(
      screen.getByRole('switch', { name: 'When a machine goes unreachable' }).getAttribute('aria-checked'),
    ).toBe('false')
    expect(screen.getByRole('switch', { name: 'Quiet while a dashboard is open' }).getAttribute('aria-checked')).toBe('true')
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
