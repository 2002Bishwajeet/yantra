import { type FormEvent, useState } from 'react'
import { Title } from '@/components/Title'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { Input } from '@/components/ui/input'

/** Where the daemon writes it, named here because the page is the only place a
 *  person learns the token is on disk in plain text
 *  ([ADR-0021](../../../docs/adr/0021-the-relay-is-written-to-an-environment-file.md)). */
const FILE = '/etc/yantra/daemon.env'

type Sent =
  | { sent: 'no' }
  | { sent: 'sending' }
  | { sent: 'set' }
  // `null` is a request that never got an answer, which is not a refusal.
  | { sent: 'refused'; status: number | null; said: string }

/** The daemon writes before it sends, so **502 is not a failed save** — the
 *  relay is on disk and the message did not arrive. Collapsing that into
 *  "failed" would have someone type it all in again. */
const refusals: Record<number, string> = {
  400: 'That is not a usable topic URL or token.',
  403: "This browser is not on a node this tailnet's owner holds.",
  500: `The relay could not be written to ${FILE}.`,
  502: 'The relay is written down, and the test message did not arrive.',
  503: 'The daemon could not ask Tailscale who is calling, so nothing about you was decided.',
}

function refusal(status: number | null): string {
  if (status === null) return 'The daemon did not answer.'
  return refusals[status] ?? 'The daemon did not take it.'
}

// Outside the component for `useLooked`'s reason: the React Compiler bails out
// of a function whose try/catch holds a conditional.
async function set(body: { url: string; token?: string }): Promise<Sent> {
  try {
    const response = await fetch('/api/relay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      return {
        sent: 'refused',
        status: response.status,
        said: await response.text(),
      }
    }
    return { sent: 'set' }
  } catch (cause) {
    return { sent: 'refused', status: null, said: String(cause) }
  }
}

/** D3 §0 and §12.2. Q6 refused a settings screen for *preferences*, and this is
 *  the other thing: the two values the product does not work without, which
 *  until now were environment variables nothing could write.
 *
 *  **Nothing is read back.** The page shows no current relay, because serving
 *  one would put the token on the wire and in a browser's memory — §B4 holds
 *  everywhere ADR-0021 did not carve. So the field is empty on every visit and
 *  what you type replaces whatever is there. */
export function Settings() {
  const [outcome, setOutcome] = useState<Sent>({ sent: 'no' })

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const read = (name: string) => String(form.get(name) ?? '').trim()
    const token = read('token')

    setOutcome({ sent: 'sending' })
    setOutcome(
      // Omitted rather than sent empty: an open topic and a topic with a blank
      // password are not the same thing.
      await set({ url: read('url'), ...(token === '' ? {} : { token }) }),
    )
  }

  return (
    <>
      <Title>Settings</Title>
      <p className="text-muted-foreground max-w-prose text-sm">
        Yantra pushes to <a href="https://ntfy.sh">ntfy</a> when an agent needs
        you and the dashboard is not open. Saving writes{' '}
        <code className="font-mono">{FILE}</code> and sends one test message, so
        you find out here rather than from a phone that stays quiet.
      </p>

      <Form onSubmit={(event) => void submit(event)}>
        <Field>
          <FieldLabel htmlFor="relay-url">Topic URL</FieldLabel>
          <Input
            autoComplete="off"
            id="relay-url"
            name="url"
            placeholder="https://ntfy.sh/a-topic-nobody-guesses"
            required
          />
          <FieldDescription>
            On the public server the topic is the only password there is, so
            make it one nobody guesses — or point this at your own ntfy.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="relay-token">Token</FieldLabel>
          <Input
            autoComplete="off"
            id="relay-token"
            name="token"
            placeholder="tk_…"
            type="password"
          />
          <FieldDescription>
            Only a protected topic needs one. It is stored on the appliance in
            plain text, readable by the account the daemon runs as — that is the
            trade ADR-0021 records, and the one place Yantra holds a secret
            value rather than a reference.
          </FieldDescription>
        </Field>

        <Button
          className="self-start"
          disabled={outcome.sent === 'sending'}
          type="submit"
        >
          {outcome.sent === 'sending' ? 'sending…' : 'Save and send a test'}
        </Button>

        <div aria-live="polite">
          {outcome.sent === 'set' && (
            <Alert>
              <AlertTitle>The test message arrived at the relay.</AlertTitle>
              <AlertDescription>
                It is written in <code className="font-mono">{FILE}</code>. The
                daemon reads that file when systemd starts it, so run{' '}
                <code className="font-mono">sudo systemctl restart yantrad</code>{' '}
                on the appliance before it notifies you from this relay.
              </AlertDescription>
            </Alert>
          )}

          {outcome.sent === 'refused' && (
            <Alert variant="destructive">
              <AlertTitle>{refusal(outcome.status)}</AlertTitle>
              {/* The daemon's own words: they name the file or what the relay
                  said, and never the topic or the token. */}
              <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
                {outcome.said}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </Form>
    </>
  )
}
