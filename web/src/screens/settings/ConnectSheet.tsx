import { LogIn } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useGithubLogin } from '@/api/mutations'
import { githubQuery } from '@/api/queries'
import { Button } from '@/m3/button/Button'
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
  const connection = useQuery({
    ...githubQuery(),
    enabled: open && device !== undefined,
    refetchInterval: device === undefined ? false : device.interval * 1000,
  })
  const connected = device !== undefined && connection.data?.connected ? connection.data : null
  const now = useTick(open && device !== undefined && connected === null)
  // The tick may predate the write by a few ms; elapsed never counts backwards.
  const elapsed = Math.max(0, Math.floor((now - login.submittedAt) / 1000))
  const left = device === undefined ? 0 : Math.max(0, device.expires_in - elapsed)
  const expired = device !== undefined && connected === null && left === 0

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
          <Text as="p" scale="title-medium" emphasized>
            Signed in as {connected.login ?? 'someone'}.
          </Text>
        ) : device === undefined || expired ? (
          <>
            {expired ? (
              <Text as="p" scale="body-medium" tone="error">
                The code expired before it was typed.
              </Text>
            ) : null}
            <Button disabled={login.isPending} icon={<LogIn />} onClick={() => login.mutate()} size="m">
              {login.isPending ? 'Asking GitHub…' : 'Sign in with GitHub'}
            </Button>
            <Text as="p" scale="body-small" tone="variant">
              device flow · nothing to paste
            </Text>
          </>
        ) : (
          <>
            <Mono className="settings__code">{device.user_code}</Mono>
            <Text as="p" scale="body-medium">
              open{' '}
              <a href={device.verification_uri} rel="noreferrer" target="_blank">
                {device.verification_uri.replace(/^https?:\/\//, '')}
              </a>{' '}
              and enter the code
            </Text>
            <Text as="p" aria-live="polite" scale="body-small" tone="variant">
              waiting · the code is good for {Math.ceil(left / 60)}m
            </Text>
          </>
        )}
        {login.error ? (
          <div aria-live="polite" className="settings__outcome">
            <Text as="p" scale="body-medium" tone="error" emphasized>
              {login.error.describe()}
            </Text>
            <Mono className="settings__said">{login.error.said}</Mono>
          </div>
        ) : null}
        <Text as="p" scale="body-small" tone="variant">
          Yantra asks for these scopes and nothing more:
        </Text>
        <List aria-label="Scopes">
          {SCOPES.map(([scope, why]) => (
            <ListItem headline={<Mono>{scope}</Mono>} key={scope} supporting={why} />
          ))}
        </List>
        <Text as="p" scale="body-small" tone="variant">
          Yantra keeps this grant and never sends it to a machine. A clone uses the machine's own git sign-in, which the
          doctor checks.
        </Text>
      </div>
    </Sheet>
  )
}
