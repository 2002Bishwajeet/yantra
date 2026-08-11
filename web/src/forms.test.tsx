/**
 * Y-195: the two forms use the ported primitives, and the verbs that cannot be
 * undone ask first.
 *
 * The primitives' own behaviour is Base UI's and is pinned by
 * `primitives.test.tsx`. What this asserts is the two things D3 makes rules of:
 * that no control here is hand-rolled (§7.4), and that `delete` and `kill` open
 * a question while `stop` and `resume` do not (§4.7).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Machine, Workspace } from './api'
import { Act, Kill } from './components/Act'
import { EditWorkspace } from './components/EditWorkspace'
import { NewWorkspace } from './components/NewWorkspace'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const site: Workspace = {
  name: 'site',
  machine: 'cachyos-g14',
  repo: '/code/site',
  startup: null,
}

const machines: Machine[] = [
  {
    name: 'cachyos-g14',
    dns_name: 'cachyos-g14.tail.ts.net',
    os: 'linux',
    online: true,
    expired: false,
    last_seen: null,
    heartbeat: null,
  },
]

const editing = () =>
  render(
    <EditWorkspace machines={machines} onClose={() => {}} workspace={site} />,
  )

/** Every write here answers a body and a status, so one stub covers the POSTs
 *  and the DELETEs. It returns what was asked of the daemon. */
function stubWrite(status: number, body: unknown) {
  const asked = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      asked(init?.method, path)
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(String(body)),
      })
    }),
  )
  return asked
}

describe('the forms use the ported primitives', () => {
  /** The failure this prevents is silent: a hand-rolled control keeps its look
   *  until the tokens move and then loses its focus ring (D3 §7.4). */
  const ported = (container: HTMLElement) => ({
    inputs: container.querySelectorAll('input:not([data-slot="input"])'),
    labels: container.querySelectorAll('label:not([data-slot="field-label"])'),
    submits: container.querySelectorAll(
      'button[type="submit"]:not([data-slot="button"])',
    ),
  })

  it('leaves no hand-rolled input, label or submit button on the create form', () => {
    const { container } = render(<NewWorkspace machines={machines} />)
    const bare = ported(container)

    expect(bare.inputs.length).toBe(0)
    expect(bare.labels.length).toBe(0)
    expect(bare.submits.length).toBe(0)
    expect(container.querySelector('[data-slot="form"]')).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'Create workspace' }).dataset.slot,
    ).toBe('button')
  })

  it('leaves no hand-rolled input, label or submit button on the edit form', () => {
    const { container } = editing()
    const bare = ported(container)

    expect(bare.inputs.length).toBe(0)
    expect(bare.labels.length).toBe(0)
    expect(bare.submits.length).toBe(0)
    expect(container.querySelector('[data-slot="form"]')).not.toBeNull()
  })

  /** The one control left, and it is deliberate: D3 §14 gives `ui/select` and
   *  `ui/combobox` to Y-185 along with the `/new` route. */
  it('still asks a native select for the machine', () => {
    const { container } = render(<NewWorkspace machines={machines} />)
    expect(container.querySelectorAll('select').length).toBe(1)
  })

  /** Base UI generates an id where it is given none, and the three fields are
   *  asked for by id elsewhere, so each control keeps the one it had. */
  it('keeps every label pointing at the control it names', () => {
    editing()
    const asked = (label: string, id: string) =>
      screen.getByLabelText(label, { selector: `#${id}` })

    expect((asked('Machine', 'edit-machine') as HTMLSelectElement).value).toBe(
      'cachyos-g14',
    )
    expect((asked('Repo', 'edit-repo') as HTMLInputElement).value).toBe(
      '/code/site',
    )
    expect(asked('Startup', 'edit-startup')).toBeTruthy()
  })

  it('sends what the ported inputs hold', async () => {
    const asked = stubWrite(200, { ...site, repo: '/code/fixed' })
    editing()

    fireEvent.change(screen.getByLabelText('Repo'), {
      target: { value: '/code/fixed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Edited site.')).toBeTruthy()
    expect(asked).toHaveBeenCalledWith('PATCH', '/api/workspaces/site')
  })
})

describe('what cannot be undone asks first', () => {
  const wrote = (asked: ReturnType<typeof stubWrite>, method: string) =>
    asked.mock.calls.filter((call) => call[0] === method)

  it('does not delete a workspace until the question is answered', async () => {
    const asked = stubWrite(200, { machine: 'cachyos-g14', removed: true })
    editing()

    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    expect(await screen.findByText('Delete site?')).toBeTruthy()
    expect(wrote(asked, 'DELETE').length).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }))

    expect(await screen.findByText(/^Deleted site\./)).toBeTruthy()
    expect(wrote(asked, 'DELETE')).toEqual([['DELETE', '/api/workspaces/site']])
  })

  /** §8: the question says what it will not touch, since there is no undo to
   *  offer once it is answered. */
  it('names what the delete leaves alone', async () => {
    stubWrite(200, { machine: 'cachyos-g14', removed: true })
    editing()

    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))

    expect(
      await screen.findByText(/The repo on cachyos-g14 .* stay as they are/),
    ).toBeTruthy()
  })

  it('deletes nothing when the question is dismissed', async () => {
    const asked = stubWrite(200, { machine: 'cachyos-g14', removed: true })
    editing()

    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    await screen.findByText('Delete site?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(wrote(asked, 'DELETE').length).toBe(0)
  })

  it('does not kill a session until the question is answered', async () => {
    const asked = stubWrite(200, {
      machine: 'pi',
      session: 'scratch',
      killed: true,
    })
    render(<Kill machine="pi" session="scratch" />)

    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    expect(await screen.findByText('Kill scratch on pi?')).toBeTruthy()
    expect(wrote(asked, 'DELETE').length).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Kill it' }))

    expect(await screen.findByText('Killed scratch on pi.')).toBeTruthy()
    expect(wrote(asked, 'DELETE')).toEqual([
      ['DELETE', '/api/machines/pi/sessions/scratch'],
    ])
  })

  it('kills nothing when the question is dismissed', async () => {
    const asked = stubWrite(200, {
      machine: 'pi',
      session: 'scratch',
      killed: true,
    })
    render(<Kill machine="pi" session="scratch" />)

    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    await screen.findByText('Kill scratch on pi?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(wrote(asked, 'DELETE').length).toBe(0)
  })

  /** I-30: absence is the state that was asked for, so a session that was
   *  already gone is a fact to report rather than a failure. */
  it('says a session was already gone rather than that the kill failed', async () => {
    stubWrite(200, { machine: 'pi', session: 'scratch', killed: false })
    render(<Kill machine="pi" session="scratch" />)

    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Kill it' }))

    expect(
      await screen.findByText(/No session named scratch was running on pi/),
    ).toBeTruthy()
  })
})

describe('what a second tap undoes does not ask', () => {
  it('stops on the tap', async () => {
    const asked = stubWrite(200, {
      machine: 'cachyos-g14',
      stopped: true,
      ending: null,
    })
    render(<Act verb="down" workspace={site} />)

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    expect(await screen.findByText('Stopped on cachyos-g14.')).toBeTruthy()
    expect(asked).toHaveBeenCalledWith('POST', '/api/workspaces/site/down')
    expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull()
  })

  /** ADR-0015 is why there is no undo to offer instead: a resumed conversation
   *  is a fork, and the daemon keeps nothing that would put back a stop. */
  it('resumes on the tap', async () => {
    const asked = stubWrite(200, {
      machine: 'cachyos-g14',
      resumed: true,
      term: 'xterm-256color',
    })
    render(<Act verb="resume" workspace={site} />)

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))

    expect(await screen.findByText(/^Resumed on cachyos-g14\./)).toBeTruthy()
    expect(asked).toHaveBeenCalledWith('POST', '/api/workspaces/site/resume')
    expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull()
  })
})
