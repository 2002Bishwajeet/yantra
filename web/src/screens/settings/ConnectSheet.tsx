import { ExternalLink, LogIn } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { keys } from '@/api/keys'
import { grant, signedIn } from '@/lib/github'
import { useGithubLogin } from '@/api/mutations'
import { useGithubReadiness } from '@/api/hooks'
import { githubQuery, githubReadinessQuery } from '@/api/queries'
import { Button } from '@/m3/button/Button'
import { Copyable, useCopy } from '@/m3/copyable/Copyable'
import { List, ListItem } from '@/m3/list/List'
import { Mono, Text } from '@/m3/text/Text'
import { useTick } from '@/useTick'
import { Sheet } from './Sheet'

/** What ADR-0023 asks for, and nothing more. The daemon's own list; the
 *  page repeats it so the person sees it before typing the code. */
const SCOPES = [
  ['repo', 'private repositories'],
  ['read:org', 'your organisations'],
  ['notifications', 'reviews and issues'],
] as const

/** The device flow (SettingsProviderConnect). One write starts it; the daemon
 *  polls GitHub, and this sheet polls the daemon at the interval GitHub named,
 *  only while it is open. The token is never on the wire in this direction. */
export function ConnectSheet(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { open, onOpenChange } = props
  const login = useGithubLogin()
  const device = login.data
  const copier = useCopy(device?.user_code ?? '')
  const connection = useQuery({
    ...githubQuery(),
    enabled: open && device !== undefined,
    refetchInterval: device === undefined ? false : device.interval * 1000,
  })
  // `pending` is true from the login write until the daemon ends the flow, and a failed flow ends too, keeping the old grant.
  const ended = device !== undefined && connection.data?.connected === true && !connection.data.pending
  const client = useQueryClient()
  // Ended is not signed in: only a fresh look at GitHub says whether this flow landed or was abandoned.
  const [looked, setLooked] = useState<number | null>(null)
  useEffect(() => {
    if (!ended) return
    const flow = login.submittedAt
    void client
      .fetchQuery({ ...githubReadinessQuery(), staleTime: 0 })
      .catch(() => undefined)
      .then(() => {
        setLooked(flow)
        void client.invalidateQueries({ queryKey: keys.github() })
      })
  }, [ended, login.submittedAt, client])
  const readiness = useGithubReadiness()
  const settled = ended && looked === login.submittedAt
  const accepted = settled && grant(connection.data, readiness).kind === 'accepted'
  const connected = accepted ? (connection.data ?? null) : null
  const failed = settled && !accepted
  const now = useTick(open && device !== undefined && connected === null && !failed)
  // The tick may predate the write by a few ms; elapsed never counts backwards.
  const elapsed = Math.max(0, Math.floor((now - login.submittedAt) / 1000))
  const left = device === undefined ? 0 : Math.max(0, device.expires_in - elapsed)
  const expired = device !== undefined && connected === null && !failed && left === 0

  const close = (next: boolean) => {
    if (!next) login.reset()
    onOpenChange(next)
  }

  return (
    <Sheet
      actions={
        <Button onClick={() => close(false)} variant="text">
          {connected ? 'Done' : 'Cancel'}
        </Button>
      }
      description="Yantra signs in to GitHub once and keeps the grant. New session browses and searches your repositories, private ones too, and reviews, issues and pull requests come through the same sign-in. Cloning still runs git on the machine."
      onOpenChange={close}
      open={open}
      title="Connect GitHub"
    >
      <div className="settings__connect">
        {connected ? (
          <Text render={<p />} scale="title-medium" emphasized>
            {signedIn(connected.login)}.
          </Text>
        ) : device === undefined || expired || failed ? (
          <>
            {failed ? (
              <Text render={<p />} scale="body-medium" tone="error">
                The sign-in did not finish. GitHub has not accepted a new grant.
              </Text>
            ) : null}
            {expired ? (
              <Text render={<p />} scale="body-medium" tone="error">
                The code expired before it was typed.
              </Text>
            ) : null}
            <Button disabled={login.isPending} icon={<LogIn />} onClick={() => login.mutate()} size="m">
              {login.isPending ? 'Asking GitHub…' : 'Sign in with GitHub'}
            </Button>
            <Text render={<p />} scale="body-small" tone="variant">
              device flow · nothing to paste
            </Text>
          </>
        ) : (
          <>
            <Copyable copier={copier} text={device.user_code} what="the code" />
            <Button
              icon={<ExternalLink />}
              onClick={() => void copier.copy()}
              render={<a href={device.verification_uri} rel="noreferrer" target="_blank" />}
              size="m"
            >
              Copy code and open GitHub
            </Button>
            <Text render={<p />} scale="body-small" tone="variant">
              Paste the code on GitHub and approve · this sheet continues by itself
            </Text>
            <Text render={<p />} aria-live="polite" scale="body-small" tone="variant">
              waiting · the code is good for {Math.ceil(left / 60)}m
            </Text>
          </>
        )}
        {login.error ? (
          <div aria-live="polite" className="settings__outcome">
            <Text render={<p />} scale="body-medium" tone="error" emphasized>
              {login.error.describe()}
            </Text>
            <Mono className="settings__said">{login.error.said}</Mono>
          </div>
        ) : null}
        <Text render={<p />} scale="body-small" tone="variant">
          Yantra asks for these scopes and nothing more:
        </Text>
        <List aria-label="Scopes">
          {SCOPES.map(([scope, why]) => (
            <ListItem headline={<Mono>{scope}</Mono>} key={scope} supporting={why} />
          ))}
        </List>
        <Text render={<p />} scale="body-small" tone="variant">
          Yantra keeps this grant and never sends it to a machine. A clone uses the machine's own git sign-in, which the
          doctor checks.
        </Text>
      </div>
    </Sheet>
  )
}
