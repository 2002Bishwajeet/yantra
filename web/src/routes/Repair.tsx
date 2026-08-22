import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import type { Broken, Workspace } from '@/api'
import { Title } from '@/components/Title'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { Skeleton } from '@/components/ui/skeleton'

const route = getRouteApi('/w/$name/repair')

const path = (name: string) =>
  `/api/workspaces/${encodeURIComponent(name)}/repair`

type Opened =
  | { opened: 'yes'; file: Broken }
  // `null` is a request that never got an answer, which is not a refusal.
  | { opened: 'no'; status: number | null; said: string }

type Sent =
  | { sent: 'no' }
  | { sent: 'sending' }
  | { sent: 'repaired'; workspace: Workspace }
  | { sent: 'refused'; status: number | null; said: string }

/** Each code means a different thing, and collapsing them into "failed" sends
 *  the operator hunting a mistake they may not have made. **409 is the one
 *  worth reading twice**: the file loads, so there is nothing here to do. */
const refusals: Record<number, string> = {
  400: 'Those bytes still will not load.',
  403: "This browser is not on a node this tailnet's owner holds.",
  409: 'That file loads, so there is nothing to repair.',
  422: 'The dashboard sent a field the daemon does not know.',
  503: 'The daemon could not ask Tailscale who is calling, so nothing about you was decided.',
}

function refusal(status: number | null): string {
  if (status === null) return 'The daemon did not answer.'
  return refusals[status] ?? 'The daemon refused it.'
}

// Outside the component for the reason `useLooked`'s `look` is: the React
// Compiler bails out of a function whose try/catch holds a conditional.
async function open(name: string, signal: AbortSignal): Promise<Opened> {
  try {
    const response = await fetch(path(name), { signal })
    if (!response.ok) {
      return {
        opened: 'no',
        status: response.status,
        said: await response.text(),
      }
    }
    return { opened: 'yes', file: (await response.json()) as Broken }
  } catch (cause) {
    if (signal.aborted) throw cause
    return { opened: 'no', status: null, said: String(cause) }
  }
}

async function save(name: string, text: string): Promise<Sent> {
  try {
    const response = await fetch(path(name), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) {
      return {
        sent: 'refused',
        status: response.status,
        said: await response.text(),
      }
    }
    return { sent: 'repaired', workspace: (await response.json()) as Workspace }
  } catch (cause) {
    return { sent: 'refused', status: null, said: String(cause) }
  }
}

/** D3 §7.5: the one place the founding UI principle is broken, closed.
 *  `yantra edit` cannot repair a file that will not load — `update` loads before
 *  it writes — so until now the dashboard named the error and offered nothing.
 *
 *  **This is the only surface that edits a workspace as text**, and
 *  [ADR-0020](../../../docs/adr/0020-a-raw-write-only-from-broken-to-valid.md)
 *  is why it is safe to have: it opens only on a file that will not load, and
 *  the save refuses bytes that still will not. The cost is that a partial fix
 *  cannot be saved and come back to — on a phone, half-way through a file with
 *  two errors, that is a real loss. */
export function Repair() {
  const { name } = route.useParams()
  const [outcome, setOutcome] = useState<Sent>({ sent: 'no' })
  const { data } = useQuery({
    queryKey: [path(name)],
    queryFn: ({ signal }) => open(name, signal),
    // The file changes when this page changes it, and a refetch under a
    // half-typed repair would be an argument the browser cannot win.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  })

  const heading = <Title>Repair {name}</Title>

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = String(new FormData(event.currentTarget).get('text') ?? '')
    setOutcome({ sent: 'sending' })
    setOutcome(await save(name, text))
  }

  if (data === undefined) {
    return (
      <>
        {heading}
        <div className="flex flex-col gap-2" data-slot="reading">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
      </>
    )
  }

  if (data.opened === 'no') {
    return (
      <>
        {heading}
        <Alert variant="destructive">
          <AlertTitle>{refusal(data.status)}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span className="font-mono text-xs whitespace-pre-wrap">
              {data.said}
            </span>
            <Link params={{ name }} to="/w/$name">
              {name}
            </Link>
          </AlertDescription>
        </Alert>
      </>
    )
  }

  if (outcome.sent === 'repaired') {
    return (
      <>
        {heading}
        <Alert>
          <AlertTitle>
            {outcome.workspace.name} loads now, on {outcome.workspace.machine}.
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span className="font-mono text-xs">{outcome.workspace.repo}</span>
            <span>
              The workspaces reading is taken every 30 s, so the fleet may not
              list it yet.
            </span>
            <Link params={{ name }} to="/w/$name">
              {name}
            </Link>
          </AlertDescription>
        </Alert>
      </>
    )
  }

  return (
    <>
      {heading}
      {/* The error first and the bytes under it: on a 390 px phone "beside"
          is above, and the sentence is what the edit is answering. */}
      <Alert variant="destructive">
        <AlertTitle>{name} will not load.</AlertTitle>
        <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
          {data.file.error}
        </AlertDescription>
      </Alert>

      <Form onSubmit={(event) => void submit(event)}>
        <Field>
          <FieldLabel htmlFor="repair-text">The file</FieldLabel>
          {/* No `ui/textarea` was ported, so this carries `ui/input`'s own
              classes rather than a hand-picked set (D3 §7.4). */}
          <textarea
            className="border-input bg-background focus-visible:ring-ring/50 min-h-64 w-full rounded-md border px-3 py-2 font-mono text-sm outline-none focus-visible:ring-[3px]"
            defaultValue={data.file.text}
            id="repair-text"
            name="text"
            spellCheck={false}
          />
          <FieldDescription>
            {data.file.path} on the machine running the daemon. Saving refuses
            bytes that still will not load, so a half-finished fix cannot be
            kept.
          </FieldDescription>
        </Field>

        <Button
          className="self-start"
          disabled={outcome.sent === 'sending'}
          type="submit"
        >
          {outcome.sent === 'sending' ? 'saving…' : 'Save the file'}
        </Button>

        {outcome.sent === 'refused' && (
          <Alert variant="destructive">
            <AlertTitle>{refusal(outcome.status)}</AlertTitle>
            {/* The daemon's own sentence, whole: it names the *next* error, and
                that is the one left to answer. */}
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
              {outcome.said}
            </AlertDescription>
          </Alert>
        )}
      </Form>
    </>
  )
}
