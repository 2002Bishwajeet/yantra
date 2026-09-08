import { useState } from 'react'
import { Box, GitBranch, GitFork, Sparkles } from 'lucide-react'
import { useGithub, useReadiness } from '@/api/hooks'
import { useGithubLogout } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { Lead } from '@/m3/lead/Lead'
import { ListItem } from '@/m3/list/List'
import { Mono, Text } from '@/m3/text/Text'
import { useFormFactor } from '@/shell/formFactor'
import { ConnectSheet } from './ConnectSheet'
import { Group, Note } from './Group'
import { onMachines, presentOn } from './readiness'
import { Sheet } from './Sheet'

export function Providers() {
  const github = useGithub()
  const readiness = useReadiness()
  const [sheet, setSheet] = useState<'connect' | 'manage' | null>(null)
  // The phone row is 390 px less a lead and a chevron, and `.m3-clip` cuts
  // rather than wraps, so the phone takes the boards' shorter strings.
  const phone = useFormFactor() === 'phone'
  if (github.error) throw github.error
  const connection = github.data

  return (
    <>
      <Group label="Hosting">
        <ListItem
          headline="GitHub"
          leading={
            <Lead>
              <GitBranch />
            </Lead>
          }
          supporting={
            connection === undefined
              ? 'asking the daemon'
              : connection.connected
                ? phone
                  ? `Connected as ${connection.login ?? 'someone'}`
                  : `signed in as ${connection.login ?? 'someone'} · repositories, reviews, issues`
                : 'Not connected'
          }
          trailing={
            connection === undefined ? undefined : connection.connected ? (
              <Button onClick={() => setSheet('manage')} variant="text">
                Manage
              </Button>
            ) : (
              <Button onClick={() => setSheet('connect')} variant="tonal">
                Connect
              </Button>
            )
          }
        />
        <ListItem
          headline="GitLab"
          leading={
            <Lead>
              <GitFork />
            </Lead>
          }
          supporting="not connected"
          trailing={
            <Button disabled variant="text">
              Connect
            </Button>
          }
        />
      </Group>
      <Group label="LLM">
        <ListItem
          headline="Anthropic"
          leading={
            <Lead tone="primary">
              <Sparkles />
            </Lead>
          }
          supporting={
            phone
              ? onMachines(presentOn(readiness, 'login-session'), 'Signed in')
              : `Claude subscription · ${onMachines(presentOn(readiness, 'login-session'), 'signed in')}`
          }
        />
        <ListItem
          headline="OpenAI"
          leading={
            <Lead>
              <Box />
            </Lead>
          }
          supporting={phone ? 'Later · nothing uses it yet' : 'not set up · for a future agent, nothing uses it yet'}
          trailing={
            <Button disabled variant="text">
              Connect
            </Button>
          }
        />
      </Group>
      <Note>
        Yantra stores references, never keys. A key lives in your 1Password, pass or sops and is resolved on the
        machine that runs the agent.
      </Note>
      <ConnectSheet onOpenChange={(open) => setSheet(open ? 'connect' : null)} open={sheet === 'connect'} />
      <ManageSheet login={connection?.login ?? null} onOpenChange={(open) => setSheet(open ? 'manage' : null)} open={sheet === 'manage'} />
    </>
  )
}

function ManageSheet(props: { open: boolean; onOpenChange: (open: boolean) => void; login: string | null }) {
  const { open, onOpenChange, login } = props
  const logout = useGithubLogout()
  return (
    <Sheet
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} variant="text">
            Cancel
          </Button>
          <Button
            disabled={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSuccess: () => onOpenChange(false) })}
            tone="error"
            variant="tonal"
          >
            {logout.isPending ? 'Signing out…' : 'Sign out'}
          </Button>
        </>
      }
      description={`Signed in as ${login ?? 'someone'}. Yantra keeps this grant on the appliance and never sends it to a machine; signing out drops it from memory and from the env file.`}
      onOpenChange={onOpenChange}
      open={open}
      title="GitHub"
    >
      {logout.error ? (
        <div aria-live="polite" className="settings__outcome">
          <Text as="p" scale="body-medium" tone="error" emphasized>
            {logout.error.describe()}
          </Text>
          <Mono className="settings__said">{logout.error.said}</Mono>
        </div>
      ) : null}
    </Sheet>
  )
}
