import { type FormEvent, useState } from 'react'
import type { Machine, Workspace } from '@/api'
import { type Chosen, Dirs } from '@/components/Dirs'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group'
import { nativeSelect } from '@/lib/control'
import { derive, USABLE_NAME } from '@/lib/name'

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

/** **Two, not D4 §4.4's three, and the schema is why.** A workspace holds a
 *  `startup` *command*, not an agent choice. `startup: null` means it runs
 *  nothing of its own, and it is the dashboard's Start button that then passes
 *  `agent: 'claude'` ([`Act.tsx`](./Act.tsx)) — so *claude* and *a plain shell*
 *  are the same file, told apart at `up` time rather than in it. Offering both
 *  would have written `startup = "claude"`, which ADR-0015 reads as a workspace
 *  that starts something of its own: no resume, and `—` in the agent column.
 *
 *  ADR-0011 ships one agent and D1 §4.2 records that the owner wants others, so
 *  this renders the guardrail rather than relaxing it. */
type Opens = 'claude' | 'other'

/** D4. Machine, directory and agent are each chosen from what Yantra knows, and
 *  the directory is confirmed on the machine before the file is written.
 *
 *  The `201` carries the whole workspace and is rendered from there: the read
 *  model refreshes every 30 s, so re-reading the list to confirm a create draws
 *  an empty one immediately after a success. */
export function NewWorkspace({ machines }: { machines: Machine[] }) {
  const [outcome, setOutcome] = useState<Sent>({ sent: 'no' })
  const [machine, setMachine] = useState('')
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [opens, setOpens] = useState<Opens>('claude')
  const [command, setCommand] = useState('')
  // A name that has been typed stops following the directory: a field that
  // keeps overwriting what you wrote is worse than one you have to fill.
  const [typed, setTyped] = useState<string | null>(null)

  const name = typed ?? (chosen ? derive(chosen.path, chosen.origin) : '')
  const named = name !== '' && USABLE_NAME.test(name)
  // D4 §5: only a **proven** absence blocks. A machine that could not be asked
  // is not a directory that is not there, and refusing both would mean you
  // cannot set up a workspace for a laptop that is shut (ADR-0009).
  const blocked = chosen?.checked === 'no'
  const ready = machine !== '' && chosen !== null && named && !blocked

  // `claude` is the absence of a startup command, not the string "claude".
  const startup = () => (opens === 'other' ? command.trim() : '')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!ready || !chosen) return
    const command = startup()

    setOutcome({ sent: 'sending' })
    setOutcome(
      await create({
        name,
        machine,
        repo: chosen.path,
        // Omitted rather than sent empty: absent is "just a shell", and
        // `startup = ""` is a command that cannot run.
        ...(command === '' ? {} : { startup: command }),
      }),
    )
  }

  return (
    <Form onSubmit={(event) => void submit(event)}>
      {/* ADR-0009: Yantra never resolves a machine, so an asleep one is a
          legitimate target and is offered like any other. */}
      <Field>
        <FieldLabel htmlFor="new-machine">Machine</FieldLabel>
        <select
          className={nativeSelect}
          id="new-machine"
          name="machine"
          onChange={(event) => {
            // A path is a fact about one machine, and the choice is this
            // form's rather than the picker's — the picker unmounts.
            setMachine(event.target.value)
            setChosen(null)
            setTyped(null)
          }}
          required
          value={machine}
        >
          <option disabled value="">
            choose a machine
          </option>
          {machines.map((one) => (
            <option key={one.name} value={one.name}>
              {one.online ? one.name : `${one.name} — offline`}
            </option>
          ))}
        </select>
      </Field>

      {machine !== '' && (
        <Dirs chosen={chosen} machine={machine} onChoose={setChosen} />
      )}

      {chosen && (
        <Alert variant={blocked ? 'destructive' : 'default'}>
          <AlertTitle>
            {blocked
              ? `${machine} has no directory at ${chosen.path}.`
              : chosen.path}
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            {blocked && <span>Make it there, or choose another.</span>}
            {chosen.checked === 'unknown' && (
              <>
                <span>
                  {machine} could not be asked, so this path is unchecked. It
                  will be tried when the workspace is opened.
                </span>
                <span className="font-mono text-xs whitespace-pre-wrap">
                  {chosen.because}
                </span>
              </>
            )}
            {chosen.checked === 'yes' && chosen.origin === null && (
              <span>Not a git repository — fine, if that is what you meant.</span>
            )}
            {chosen.origin && (
              <span className="font-mono text-xs">{chosen.origin}</span>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Field>
        <FieldLabel htmlFor="new-name">Name</FieldLabel>
        <Input
          autoComplete="off"
          id="new-name"
          name="name"
          onChange={(event) => setTyped(event.target.value)}
          required
          value={name}
        />
        <FieldDescription>
          {name !== '' && !named
            ? 'The daemon takes letters, digits, - and _ and nothing else, so it would refuse this one.'
            : 'Taken from the directory until you change it.'}
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel>Opens with</FieldLabel>
        {/* The ported segmented control rather than two bare radios: §7.4 is
            about what loses its focus ring when the tokens change. */}
        <ToggleGroup
          onValueChange={(value) => {
            const one = value[0]
            if (one === 'claude' || one === 'other') setOpens(one)
          }}
          value={[opens]}
          variant="outline"
        >
          <ToggleGroupItem value="claude">claude</ToggleGroupItem>
          <ToggleGroupItem value="other">a command…</ToggleGroupItem>
        </ToggleGroup>
        {opens === 'other' && (
          <Input
            aria-label="Command"
            autoComplete="off"
            onChange={(event) => setCommand(event.target.value)}
            placeholder="nvim ."
            value={command}
          />
        )}
        <FieldDescription>
          {opens === 'claude'
            ? 'The workspace runs nothing of its own, and Start opens the agent in it. A plain shell is `yantra up` without an agent, or a command below.'
            : 'It is a shell command, so a secret stays a reference the shell resolves — op://…, pass show … — and Yantra never holds the value. A workspace that starts its own thing is not offered Resume (ADR-0015).'}
        </FieldDescription>
      </Field>

      <Button
        className="self-start"
        disabled={!ready || outcome.sent === 'sending'}
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
              The workspaces reading is taken every 30 s, so the fleet may not
              list it yet.
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
