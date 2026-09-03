import { type FormEvent, useState } from 'react'
import type { Machine, Workspace } from '@/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { Input } from '@/components/ui/input'

type Sent =
  | { sent: 'no' }
  | { sent: 'sending' }
  | { sent: 'made'; workspace: Workspace }
  // `null` is a request that never got an answer, which is not a refusal.
  | { sent: 'refused'; status: number | null; said: string }

/** Each code the route answers means a different thing, and collapsing them
 *  into "failed" sends the operator hunting a mistake they may not have made. */
const refusals: Record<number, string> = {
  400: 'That name is unusable, or a field was left empty.',
  403: "This browser is not on a node this tailnet's owner holds.",
  409: 'That name is already a workspace.',
  422: 'The dashboard sent a field the daemon does not know.',
  503: 'The daemon could not ask Tailscale who is calling, so nothing about you was decided.',
}

function refusal(status: number | null): string {
  if (status === null) return 'The daemon did not answer.'
  return refusals[status] ?? 'The daemon did not create it.'
}

type Create = {
  name: string
  machine: string
  repo: string
  startup?: string
}

// Outside the component for the reason `useLooked`'s `look` is: the React
// Compiler bails out of a function whose try/catch holds a conditional.
async function create(body: Create): Promise<Sent> {
  try {
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.status !== 201) {
      return {
        sent: 'refused',
        status: response.status,
        said: await response.text(),
      }
    }
    return { sent: 'made', workspace: (await response.json()) as Workspace }
  } catch (cause) {
    return { sent: 'refused', status: null, said: String(cause) }
  }
}

/** What is left of the hand-rolled styling: a native `<select>`, which
 *  [D3](../../../docs/design/03-dashboard-surface.md) §14 gives to Y-185 along
 *  with `ui/select` and `ui/combobox`. Every other control here is ported. */
export const field =
  'border-input bg-background focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]'

/** The `201` carries the whole workspace, and it is rendered from there: the
 *  read model refreshes every 30 s, so re-reading the list to confirm a create
 *  draws an empty one immediately after a success. */
export function NewWorkspace({ machines }: { machines: Machine[] }) {
  const [outcome, setOutcome] = useState<Sent>({ sent: 'no' })

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const read = (name: string) => String(form.get(name) ?? '').trim()
    const startup = read('startup')

    setOutcome({ sent: 'sending' })
    setOutcome(
      await create({
        name: read('name'),
        machine: read('machine'),
        repo: read('repo'),
        // Omitted rather than sent empty: absent is "just a shell", and
        // `startup = ""` is a command that cannot run.
        ...(startup === '' ? {} : { startup }),
      }),
    )
  }

  return (
    <Form onSubmit={(event) => void submit(event)}>
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input autoComplete="off" id="new-name" name="name" required />
      </Field>

      {/* ADR-0009: Yantra never resolves a machine, so an asleep one is a
          legitimate target and is offered like any other. */}
      <Field>
        <FieldLabel htmlFor="new-machine">Machine</FieldLabel>
        <select
          id="new-machine"
          name="machine"
          required
          defaultValue=""
          className={field}
        >
          <option value="" disabled>
            choose a machine
          </option>
          {machines.map((one) => (
            <option key={one.name} value={one.name}>
              {one.online ? one.name : `${one.name} — offline`}
            </option>
          ))}
        </select>
      </Field>

      <Field>
        <FieldLabel>Repo</FieldLabel>
        <Input
          autoComplete="off"
          id="new-repo"
          name="repo"
          placeholder="/home/you/Github/thing"
          required
        />
        <FieldDescription>
          A path on that machine. Nothing here checks it, because the filesystem
          it names is the far side's.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel>Startup</FieldLabel>
        <Input
          autoComplete="off"
          id="new-startup"
          name="startup"
          placeholder="claude"
        />
        <FieldDescription>
          Optional; blank opens a plain shell. It is a shell command, so a secret
          stays a reference the shell resolves — <code>op://…</code>,{' '}
          <code>pass show …</code> — and Yantra never holds the value.
        </FieldDescription>
      </Field>

      <Button
        className="self-start"
        disabled={outcome.sent === 'sending'}
        type="submit"
      >
        {outcome.sent === 'sending' ? 'creating…' : 'Create workspace'}
      </Button>

      {outcome.sent === 'made' && (
        <Alert>
          <AlertTitle>
            Created {outcome.workspace.name} on {outcome.workspace.machine}.
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            <span className="font-mono text-xs">{outcome.workspace.repo}</span>
            {outcome.workspace.startup && (
              <span className="font-mono text-xs">
                {outcome.workspace.startup}
              </span>
            )}
            <span>
              The workspaces reading is taken every 30 s, so the table above may
              not list it yet.
            </span>
          </AlertDescription>
        </Alert>
      )}

      {outcome.sent === 'refused' && (
        <Alert variant="destructive">
          <AlertTitle>{refusal(outcome.status)}</AlertTitle>
          {/* The daemon's own sentence, whole: it names the file, and its
              chain is the actionable half. */}
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {outcome.said}
          </AlertDescription>
        </Alert>
      )}
    </Form>
  )
}
