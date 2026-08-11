import { type FormEvent, useState } from 'react'
import type { Machine, Workspace } from '@/api'
import { Confirm } from '@/components/Act'
import { nativeSelect } from '@/lib/control'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { Input } from '@/components/ui/input'

/** What `PATCH /api/workspaces/{name}` reads. A field left out is left alone,
 *  and `startup: null` is the one `null` that means something — it is
 *  `--no-startup`, and the only way a command set once is ever taken away. */
type Change = {
  machine?: string
  repo?: string
  startup?: string | null
}

/** `DELETE /api/workspaces/{name}`. `removed: false` is a workspace that was
 *  already gone, which is the state asked for and never a failure (I-30), and a
 *  `null` machine is a file that never parsed and so named none. */
type Removed = { machine: string | null; removed: boolean }

type Sent =
  | { sent: 'no' }
  | { sent: 'same' }
  | { sent: 'sending' }
  | { sent: 'deleting' }
  | { sent: 'edited'; workspace: Workspace }
  | { sent: 'deleted'; report: Removed }
  // `null` is a request that never got an answer, which is not a refusal.
  | {
      sent: 'refused'
      of: 'edit' | 'delete'
      status: number | null
      said: string
    }

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

/** The same codes, and four of them mean something else on a delete: it is
 *  refused while a session is open rather than while a *move* would strand one,
 *  and a machine that cannot be asked is refused rather than guessed at. */
const deletions: Record<number, string> = {
  ...refusals,
  400: 'That workspace name is not one the daemon accepts.',
  409: 'A tmux session is still open on that machine, so the workspace file is still there.',
  500: 'The delete ran and failed. What it says below is the whole chain.',
  503: 'That machine could not be asked whether a session is still open, so nothing was deleted.',
}

function refusal(of: 'edit' | 'delete', status: number | null): string {
  if (status === null) return 'The daemon did not answer.'
  if (of === 'delete') return deletions[status] ?? 'The daemon did not delete it.'
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
        of: 'edit',
        status: response.status,
        said: await response.text(),
      }
    }
    return { sent: 'edited', workspace: (await response.json()) as Workspace }
  } catch (cause) {
    return { sent: 'refused', of: 'edit', status: null, said: String(cause) }
  }
}

/** No `?force=true`: the daemon refuses to strand a session and that refusal is
 *  the thing worth reading, so the dashboard never sends the flag that skips it
 *  (`yantra rm --force` is where a person means it anyway). */
async function erase(name: string): Promise<Sent> {
  const path = `/api/workspaces/${encodeURIComponent(name)}`
  try {
    const response = await fetch(path, { method: 'DELETE' })
    if (response.status !== 200) {
      return {
        sent: 'refused',
        of: 'delete',
        status: response.status,
        said: await response.text(),
      }
    }
    return { sent: 'deleted', report: (await response.json()) as Removed }
  } catch (cause) {
    return { sent: 'refused', of: 'delete', status: null, said: String(cause) }
  }
}

function deleted(name: string, report: Removed): string {
  if (!report.removed) {
    return `There was no workspace called ${name} left to delete, which is the state this asked for.`
  }
  return report.machine === null
    ? `Deleted ${name}. Its file did not parse, so it named no machine.`
    : `Deleted ${name}. Only the file went — nothing on ${report.machine} was touched.`
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

  const remove = async () => {
    setOutcome({ sent: 'deleting' })
    setOutcome(await erase(current.name))
  }

  // The form is gone once the workspace is: every field on it would edit a file
  // that is not there, and the daemon would answer each one with a `404`.
  if (outcome.sent === 'deleted') {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <AlertTitle>{deleted(current.name, outcome.report)}</AlertTitle>
          <AlertDescription>
            The workspaces reading is taken every 30 s, so the table may still
            list it.
          </AlertDescription>
        </Alert>
        <Button className="self-start" onClick={onClose} variant="outline">
          Close
        </Button>
      </div>
    )
  }

  return (
    <Form onSubmit={(event) => void submit(event)}>
      <Field>
        <FieldLabel htmlFor="edit-machine">Machine</FieldLabel>
        <select
          id="edit-machine"
          name="machine"
          defaultValue={workspace.machine}
          className={nativeSelect}
        >
          {targets.map((one) => (
            <option key={one.name} value={one.name}>
              {one.label}
            </option>
          ))}
        </select>
        <FieldDescription>
          A session still open on the machine this leaves refuses the move —
          stop it first, here or with <code>yantra down</code>.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel>Repo</FieldLabel>
        <Input
          autoComplete="off"
          defaultValue={workspace.repo}
          id="edit-repo"
          name="repo"
          required
        />
      </Field>

      <Field>
        <FieldLabel>Startup</FieldLabel>
        <Input
          autoComplete="off"
          defaultValue={workspace.startup ?? ''}
          id="edit-startup"
          name="startup"
        />
        <FieldDescription>
          Emptying this clears the command, and the session opens a plain shell.
          It is a shell command, so a secret stays a reference the shell resolves
          — <code>op://…</code>, <code>pass show …</code>.
        </FieldDescription>
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button disabled={outcome.sent === 'sending'} type="submit">
          {outcome.sent === 'sending' ? 'saving…' : 'Save changes'}
        </Button>
        <Button onClick={onClose} variant="outline">
          Close
        </Button>
        {/* §4.7: the one thing on this panel that cannot be undone. */}
        <Confirm
          body={`This deletes the workspace file and nothing else. The repo on ${current.machine} and everything in it stay as they are. Yantra keeps no copy, so writing it again is the only way back.`}
          confirm="Delete it"
          disabled={outcome.sent === 'deleting'}
          label={outcome.sent === 'deleting' ? 'deleting…' : 'Delete workspace'}
          onConfirm={() => void remove()}
          title={`Delete ${current.name}?`}
        />
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
          <AlertTitle>{refusal(outcome.of, outcome.status)}</AlertTitle>
          {/* The daemon's own sentence, whole: it names the workspace, the
              machine it may not leave and the command that ends the refusal. */}
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {outcome.said}
          </AlertDescription>
        </Alert>
      )}
    </Form>
  )
}
