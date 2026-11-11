import { type FormEvent, lazy, type ReactNode, Suspense, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { isOwnAddress, PROXY_SENTENCE } from '@/api/errors'
import { useSetRelay } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { IconButton } from '@/m3/icon-button/IconButton'
import { Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { RestartNow } from './RestartNow'
import { Sheet } from './Sheet'
import { APP_STORE, GOOGLE_PLAY, newTopic, publicTopic, topicUrl } from './topic'

const Qr = lazy(() => import('qrcode.react').then((it) => ({ default: it.QRCodeSVG })))

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

function refusal(status: number | undefined, said = ''): string {
  if (isOwnAddress(status, said)) return PROXY_SENTENCE
  if (status === undefined) return 'The daemon did not answer.'
  return refusals[status] ?? 'The daemon did not take it.'
}

function Step(props: { title: string; children: ReactNode }) {
  return (
    <li className="push-setup__step">
      <Text render={<h3 />} scale="title-small">
        {props.title}
      </Text>
      {props.children}
    </li>
  )
}

/** Y-576: push setup as one guided flow, from the phone app to a test alert.
 *  The walkthrough and Settings > Notifications both open it. */
export function PushSetup(props: { open: boolean; onOpenChange: (open: boolean) => void; onSaved?: () => void }) {
  const { open, onOpenChange, onSaved } = props
  const relay = useSetRelay()
  const [shown, setShown] = useState(false)
  const [url, setUrl] = useState('')
  // A new save starts RestartNow over; its state belongs to the save before.
  const [saves, setSaves] = useState(0)
  const [arrived, setArrived] = useState<boolean | null>(null)
  const topic = publicTopic(url)
  const link = topic ? topicUrl(topic) : null

  const send = (body: { url: string; token?: string }) => {
    setSaves((n) => n + 1)
    setArrived(null)
    relay.mutate(body, {
      onSuccess: () => onSaved?.(),
      // The daemon writes before it sends, so a 502 is still a save (§B4).
      onError: (error) => {
        if (error.status === 502) onSaved?.()
      },
    })
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const read = (name: string) => String(form.get(name) ?? '').trim()
    const token = read('token')
    // Omitted rather than sent empty: an open topic and a topic with a blank
    // password are not the same thing.
    send({ url: read('url'), ...(token === '' ? {} : { token }) })
  }

  const close = (next: boolean) => {
    if (!next) relay.reset()
    onOpenChange(next)
  }

  return (
    <Sheet
      description="Push sends an alert to your phone when an agent needs you and no dashboard is open. It goes through ntfy, a free app that needs no account, so Yantra keeps no push server of its own."
      onOpenChange={close}
      open={open}
      title="Push relay"
    >
      <form className="settings__form" id="relay" onSubmit={submit}>
        <ol className="push-setup">
          <Step title="Get the ntfy app">
            <Text render={<p />} scale="body-small" tone="variant">
              Install it on the phone that gets the alerts.
            </Text>
            <div className="push-setup__stores">
              <a href={APP_STORE} rel="noreferrer" target="_blank">
                ntfy for iPhone · App Store
              </a>
              <a href={GOOGLE_PLAY} rel="noreferrer" target="_blank">
                ntfy for Android · Google Play
              </a>
            </div>
          </Step>
          <Step title="Pick a topic">
            <TextField
              autoComplete="off"
              label="Topic URL"
              name="url"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://ntfy.sh/a-topic-nobody-guesses"
              required
              supporting="On the public server the topic is the only password there is, so make it one nobody guesses, or point this at your own ntfy."
              trailing={
                <Button onClick={() => setUrl(topicUrl(newTopic()))} variant="text">
                  Generate
                </Button>
              }
              type="url"
              value={url}
            />
            {topic && link ? (
              <div className="settings__subscribe">
                <Suspense fallback={<div className="settings__qr-wait" />}>
                  <Qr
                    aria-label={`A QR code for the ntfy topic ${topic}`}
                    marginSize={2}
                    role="img"
                    size={112}
                    value={link}
                  />
                </Suspense>
                <div className="push-setup__topic">
                  <Text render={<p />} scale="body-small" tone="variant">
                    Scan it with the phone, open the link there, or copy the URL into the app.
                  </Text>
                  <a href={link}>Open the topic</a>
                  <Copyable text={link} what="the topic URL" />
                </div>
              </div>
            ) : null}
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
          </Step>
          <Step title="Save and send a test">
            <Text render={<p />} scale="body-small" tone="variant">
              Saving writes {FILE} on the appliance and sends one test message.
            </Text>
            <div aria-live="polite" className="settings__outcome">
              {relay.isSuccess ? (
                <>
                  <Text render={<p />} scale="body-medium" emphasized>
                    The test message arrived at the relay.
                  </Text>
                  <Text render={<p />} scale="body-small" tone="variant">
                    It is written in {FILE}. The daemon reads that file when systemd starts it, so it notifies you
                    from this relay after a restart.
                  </Text>
                  <RestartNow key={saves} />
                </>
              ) : null}
              {relay.error ? (
                <>
                  <Text render={<p />} scale="body-medium" tone="error" emphasized>
                    {relay.error.kind === 'network' ? refusal(undefined) : refusal(relay.error.status, relay.error.said)}
                  </Text>
                  {/* The daemon's own words: they name the file or what the relay
                      said, and never the topic or the token. */}
                  <Mono className="settings__said">{relay.error.said}</Mono>
                  {relay.error.status === 502 ? <RestartNow key={saves} /> : null}
                </>
              ) : null}
            </div>
          </Step>
          {/* Only a 2xx reached the relay, so only then is the phone worth asking. */}
          {relay.isSuccess ? (
            <Step title={arrived === null ? 'Did it arrive?' : arrived ? 'It arrived' : 'It did not arrive'}>
              {arrived === null ? (
                <>
                  <Text render={<p />} scale="body-small" tone="variant">
                    Look at the phone. ntfy shows the test as a notification.
                  </Text>
                  <div className="push-setup__answer">
                    <Button onClick={() => setArrived(true)} type="button" variant="tonal">
                      Yes
                    </Button>
                    <Button onClick={() => setArrived(false)} type="button" variant="text">
                      No
                    </Button>
                  </div>
                </>
              ) : arrived ? (
                <Text render={<p />} scale="body-medium" emphasized>
                  Push works. Yantra alerts this phone when an agent needs you and no dashboard is open.
                </Text>
              ) : (
                <>
                  <ul className="push-setup__fixes">
                    <Text render={<li />} scale="body-small">
                      Subscribe to this topic in the ntfy app. Scan the QR again, or open the topic link on the phone.
                    </Text>
                    <Text render={<li />} scale="body-small">
                      Allow notifications for ntfy in the settings of the phone.
                    </Text>
                    <Text render={<li />} scale="body-small">
                      Check the topic URL. One wrong character is a different topic.
                    </Text>
                  </ul>
                  <div className="push-setup__answer">
                    <Button onClick={() => send(relay.variables)} type="button" variant="tonal">
                      Send another test
                    </Button>
                  </div>
                </>
              )}
            </Step>
          ) : null}
        </ol>
        <div className="m3-dialog__actions">
          <Button onClick={() => close(false)} type="button" variant="text">
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
