import { type FormEvent, useState } from 'react'
import { Bell, BellRing, CircleSlash, Eye, EyeOff, MoonStar, SquareCheck } from 'lucide-react'
import { useAbout } from '@/api/hooks'
import { useSetRelay } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { IconButton } from '@/m3/icon-button/IconButton'
import { Lead } from '@/m3/lead/Lead'
import { ListItem, ListValue } from '@/m3/list/List'
import { Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { Group, Note } from './Group'
import { Sheet } from './Sheet'

/** Where the daemon writes it, named here because the sheet is the only
 *  place a person learns the token is on disk in plain text (ADR-0021). */
const FILE = '/etc/yantra/daemon.env'

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

function refusal(status: number | undefined): string {
  if (status === undefined) return 'The daemon did not answer.'
  return refusals[status] ?? 'The daemon did not take it.'
}

/** What `notify::Watch` sends, in the daemon's own terms. The daemon decides
 *  what is worth a push, and no route changes it, so these read rather than
 *  set. The third row is not sent because a look that failed is not a change
 *  (I-47). */
const WHEN = [
  {
    icon: <BellRing />,
    headline: 'When an agent needs you',
    supporting: 'a trust prompt, and only the first time one appears',
    sent: true,
  },
  {
    icon: <SquareCheck />,
    headline: 'When a session ends',
    supporting: 'finished, crashed with its exit code, killed by a signal, or gone',
    sent: true,
  },
  {
    icon: <CircleSlash />,
    headline: 'When a machine goes unreachable',
    supporting: 'a look the daemon could not make is not a change it can report',
    sent: false,
  },
]

/** `about.relay` says whether the running daemon holds one; `saved` says a
 *  save happened in this session (§B4: nothing reads the relay itself back,
 *  so a save cannot move `relay` until yantrad restarts and this page is read
 *  again, ADR-0021). */
function relaySupporting(relay: boolean | undefined, saved: boolean): string {
  if (relay === undefined) return 'asking the daemon'
  const base = relay ? 'On · the daemon holds a relay and pushes to it' : 'Off · nothing is pushed'
  return saved ? `${base} · saved, used after yantrad restarts` : base
}

export function Notifications() {
  const about = useAbout()
  const [saved, setSaved] = useState(false)
  const [open, setOpen] = useState(false)
  if (about.error) throw about.error

  return (
    <>
      <Group label="Relay">
        <ListItem
          headline="Push relay"
          leading={
            <Lead>
              <Bell />
            </Lead>
          }
          supporting={relaySupporting(about.data?.relay, saved)}
          trailing={
            <Button onClick={() => setOpen(true)} variant="text">
              Edit
            </Button>
          }
        />
      </Group>
      <Group
        label="Push when"
        note="The daemon decides what is worth a push; there is no route that changes this, so these read rather than set."
      >
        {WHEN.map((one) => (
          <ListItem
            headline={one.headline}
            key={one.headline}
            leading={<Lead tone={one.sent ? 'primary' : undefined}>{one.icon}</Lead>}
            supporting={one.supporting}
            trailing={<ListValue>{one.sent ? 'Sent' : 'Not sent'}</ListValue>}
          />
        ))}
      </Group>
      <Group label="Quiet">
        <ListItem
          headline="Quiet while a dashboard is open"
          leading={
            <Lead>
              <MoonStar />
            </Lead>
          }
          supporting="the daemon knows when a browser is looking"
          trailing={<ListValue>Always</ListValue>}
        />
      </Group>
      <Note>An open dashboard tells the daemon so every 20 seconds, and the push stops while one is.</Note>
      <RelaySheet onOpenChange={setOpen} onSaved={() => setSaved(true)} open={open} />
    </>
  )
}

function RelaySheet(props: { open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const { open, onOpenChange, onSaved } = props
  const relay = useSetRelay()
  const [shown, setShown] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const read = (name: string) => String(form.get(name) ?? '').trim()
    const url = read('url')
    const token = read('token')
    // Omitted rather than sent empty: an open topic and a topic with a blank
    // password are not the same thing.
    relay.mutate(
      { url, ...(token === '' ? {} : { token }) },
      {
        onSuccess: () => onSaved(),
        // The daemon writes before it sends, so a 502 is still a save (§B4).
        onError: (error) => {
          if (error.status === 502) onSaved()
        },
      },
    )
  }

  const close = (next: boolean) => {
    if (!next) relay.reset()
    onOpenChange(next)
  }

  return (
    <Sheet
      description={`Yantra pushes to ntfy when an agent needs you and the dashboard is not open. Saving writes ${FILE} on the appliance and sends one test message.`}
      onOpenChange={close}
      open={open}
      title="Push relay"
    >
      <form className="settings__form" id="relay" onSubmit={submit}>
        <TextField
          autoComplete="off"
          label="Topic URL"
          name="url"
          placeholder="https://ntfy.sh/a-topic-nobody-guesses"
          required
          supporting="On the public server the topic is the only password there is, so make it one nobody guesses, or point this at your own ntfy."
          type="url"
        />
        <TextField
          autoComplete="off"
          label="Token"
          name="token"
          placeholder="tk_…"
          supporting="Only a protected topic needs one. It is kept on the appliance in plain text, readable by the account the daemon runs as."
          trailing={
            <IconButton label={shown ? 'Hide token' : 'Show token'} onClick={() => setShown((was) => !was)}>
              {shown ? <EyeOff /> : <Eye />}
            </IconButton>
          }
          type={shown ? 'text' : 'password'}
        />
        <div aria-live="polite" className="settings__outcome">
          {relay.isSuccess ? (
            <>
              <Text render={<p />} scale="body-medium" emphasized>
                The test message arrived at the relay.
              </Text>
              <Text render={<p />} scale="body-small" tone="variant">
                It is written in {FILE}. The daemon reads that file when systemd starts it, so run{' '}
                <Mono>sudo systemctl restart yantrad</Mono> on the appliance before it notifies you from this relay.
              </Text>
            </>
          ) : null}
          {relay.error ? (
            <>
              <Text render={<p />} scale="body-medium" tone="error" emphasized>
                {relay.error.kind === 'network' ? refusal(undefined) : refusal(relay.error.status)}
              </Text>
              {/* The daemon's own words: they name the file or what the relay
                  said, and never the topic or the token. */}
              <Mono className="settings__said">{relay.error.said}</Mono>
            </>
          ) : null}
        </div>
        <div className="m3-dialog__actions">
          <Button onClick={() => close(false)} variant="text">
            {relay.isSuccess ? 'Done' : 'Cancel'}
          </Button>
          <Button disabled={relay.isPending} type="submit">
            {relay.isPending ? 'Sending…' : 'Save and send a test'}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
