import { type FormEvent, useState } from 'react'
import type { Machine, Workspace } from '@/api'
import { button } from '@/components/Act'
import { field } from '@/components/NewWorkspace'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/** What `PATCH /api/workspaces/{name}` reads. A field left out is left alone,
 *  and `startup: null` is the one `null` that means something — it is
 *  `--no-startup`, and the only way a command set once is ever taken away. */
type Change = {
  machine?: string
  repo?: string
  startup?: string | null
}

type Sent =
  | { sent: 'no' }
  | { sent: 'same' }
  | { sent: 'sending' }
  | { sent: 'edited'; workspace: Workspace }
  // `null` is a request that never got an answer, which is not a refusal.
  | { sent: 'refused'; status: number | null; said: string }

/** Each code the route answers means a different thing, and the `409` is the
 *  one this row exists for: nothing broke, the daemon declined to strand a live
 *  session (Y-117, I-30), and what ends the refusal is in its own sentence. */
const refusals: Record<number, string> = {
  400: 'A workspace cannot hold an empty field.',
  403: "This browser is not on a node this tailnet's owner holds.",
  404: 'The daemon knows no workspace by that name.',
  409: 'A tmux session is still open on the machine this would leave, so nothing was changed.',
  422: 'The dashboard sent a field the daemon does not know.',
  500: 'The edit ran and failed. What it says below is the whole chain.',
  503: 'Nothing could be asked, so nothing was decided and nothing was changed.',
}

function refusal(status: number | null): string {
  if (status === null) return 'The daemon did not answer.'
  return refusals[status] ?? 'The daemon did not change it.'
}

/** Only the fields that really differ, because absent means *leave it alone*: a
 *  form that sent all three would turn fixing a typo in `repo` into a move of
 *  `machine`, which a live session refuses and which nobody asked for. */
function changes(current: Workspace, form: FormData): Change {
  const read = (name: string) => String(form.get(name) ?? '').trim()
  const startup = read('startup') === '' ? null : read('startup')
  const change: Change = {}

  if (read('machine') !== current.machine) change.machine = read('machine')
  if (read('repo') !== current.repo) change.repo = read('repo')
  if (startup !== current.startup) change.startup = startup
  return change
}

// Outside the component for the reason `useLooked`'s `look` is: the React
// Compiler bails out of a function whose try/catch holds a conditional.
async function edit(name: string, change: Change): Promise<Sent> {
  const path = `/api/workspaces/${encodeURIComponent(name)}`
  try {
    const response = await fetch(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(change),
    })
    if (response.status !== 200) {
      return {
        sent: 'refused',
        status: response.status,
        said: await response.text(),
      }
    }
    return { sent: 'edited', workspace: (await response.json()) as Workspace }
  } catch (cause) {
    return { sent: 'refused', status: null, said: String(cause) }
  }
}

/** The `200` carries the workspace as it now reads, and the next edit is
 *  measured against that rather than against the row this opened from — the
 *  workspaces reading is up to 30 s behind its own write. */
export function EditWorkspace({
  workspace,
  machines,
  onClose,
}: {
  workspace: Workspace
  machines: Machine[]
  onClose: () => void
}) {
  const [outcome, setOutcome] = useState<Sent>({ sent: 'no' })
  const current = outcome.sent === 'edited' ? outcome.workspace : workspace
  const listed = machines.map((one) => ({
    name: one.name,
    label: one.online ? one.name : `${one.name} — offline`,
  }))
  // ADR-0009 lets a machine be an `~/.ssh/config` alias the tailnet never
  // lists, and a picker missing the current one would read as a move.
  const targets = listed.some((one) => one.name === current.machine)
    ? listed
    : [{ name: current.machine, label: current.machine }, ...listed]

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const change = changes(current, new FormData(event.currentTarget))
    if (Object.keys(change).length === 0) {
      setOutcome({ sent: 'same' })
      return
    }

    setOutcome({ sent: 'sending' })
    setOutcome(await edit(current.name, change))
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="edit-machine">Machine</label>
        <select
          id="edit-machine"
          name="machine"
          defaultValue={workspace.machine}
          className={field}
        >
          {targets.map((one) => (
            <option key={one.name} value={one.name}>
              {one.label}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground text-xs">
          A session still open on the machine this leaves refuses the move —
          stop it first, here or with <code>yantra down</code>.
        </span>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="edit-repo">Repo</label>
        <input
          id="edit-repo"
          name="repo"
          required
          autoComplete="off"
          defaultValue={workspace.repo}
          className={field}
        />
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="edit-startup">Startup</label>
        <input
          id="edit-startup"
          name="startup"
          autoComplete="off"
          defaultValue={workspace.startup ?? ''}
          className={field}
        />
        <span className="text-muted-foreground text-xs">
          Emptying this clears the command, and the session opens a plain shell.
          It is a shell command, so a secret stays a reference the shell resolves
          — <code>op://…</code>, <code>pass show …</code>.
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={outcome.sent === 'sending'}
          className="bg-primary text-primary-foreground self-start rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {outcome.sent === 'sending' ? 'saving…' : 'Save changes'}
        </button>
        <button type="button" className={button} onClick={onClose}>
          Close
        </button>
      </div>

      {outcome.sent === 'same' && (
        <p className="text-muted-foreground text-sm">
          Nothing here differs from what {current.name} already says, so nothing
          was sent.
        </p>
      )}

      {outcome.sent === 'edited' && (
        <Alert>
          <AlertTitle>Edited {outcome.workspace.name}.</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            <span className="font-mono text-xs">
              {outcome.workspace.machine}
            </span>
            <span className="font-mono text-xs">{outcome.workspace.repo}</span>
            {outcome.workspace.startup === null ? (
              <span>No startup command, so it will open a plain shell.</span>
            ) : (
              <span className="font-mono text-xs">
                {outcome.workspace.startup}
              </span>
            )}
            <span>
              This is the answer to the write, not a re-read: the workspaces
              reading is taken every 30 s, so the table may still show what it
              replaced.
            </span>
          </AlertDescription>
        </Alert>
      )}

      {outcome.sent === 'refused' && (
        // A refusal the daemon reasoned about is not a crash, and the `409` is
        // the one that reads as one if it is painted like a failure.
        <Alert variant={outcome.status === 409 ? 'default' : 'destructive'}>
          <AlertTitle>{refusal(outcome.status)}</AlertTitle>
          {/* The daemon's own sentence, whole: it names the workspace, the
              machine it may not leave and the command that ends the refusal. */}
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {outcome.said}
          </AlertDescription>
        </Alert>
      )}
    </form>
  )
}
