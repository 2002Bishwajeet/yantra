import { type FormEvent, useState } from 'react'
import { Box, GitBranch, GitFork, KeyRound, Sparkles } from 'lucide-react'
import type { Connection } from '@/api'
import { useGithub, useReadiness } from '@/api/hooks'
import { useClearGithubClientId, useGithubLogout, useSetGithubClientId } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { Lead } from '@/m3/lead/Lead'
import { ListItem, ListValue } from '@/m3/list/List'
import { Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { useFormFactor } from '@/shell/formFactor'
import { ConnectSheet } from './ConnectSheet'
import { Group, Note } from './Group'
import { onMachines, presentOn } from './readiness'
import { Sheet } from './Sheet'

export function Providers() {
  const github = useGithub()
  const readiness = useReadiness()
  const [sheet, setSheet] = useState<'connect' | 'manage' | 'client-id' | null>(null)
  const [appPending, setAppPending] = useState<AppPending>(null)
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
          headline="GitHub app"
          leading={
            <Lead>
              <KeyRound />
            </Lead>
          }
          supporting={githubAppSupporting(connection, phone, resolvePending(appPending, connection))}
          trailing={
            <Button onClick={() => setSheet('client-id')} variant="text">
              Edit
            </Button>
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
          trailing={<ListValue>Later</ListValue>}
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
          supporting={phone ? 'nothing uses it yet' : 'not set up · for a future agent, nothing uses it yet'}
          trailing={<ListValue>Later</ListValue>}
        />
      </Group>
      <Note>
        Yantra stores references, never keys. A key lives in your 1Password, pass or sops and is resolved on the
        machine that runs the agent.
      </Note>
      <ConnectSheet onOpenChange={(open) => setSheet(open ? 'connect' : null)} open={sheet === 'connect'} />
      <ManageSheet login={connection?.login ?? null} onOpenChange={(open) => setSheet(open ? 'manage' : null)} open={sheet === 'manage'} />
      <ClientIdSheet
        current={connection?.client_id_custom ? connection.client_id : null}
        onOpenChange={(open) => setSheet(open ? 'client-id' : null)}
        onSaved={setAppPending}
        open={sheet === 'client-id'}
      />
    </>
  )
}

/** D7 §4.6: a save is not read back (Y-393, same as the relay), so the row
 *  holds what the sheet just wrote until a poll of `/api/github` shows it —
 *  `kind: 'custom'` compares the id, `'own'` just waits for the flag to drop. */
type AppPending = { kind: 'custom'; id: string } | { kind: 'own' } | null

function resolvePending(pending: AppPending, connection: Connection | undefined): AppPending {
  if (!pending || !connection) return pending
  if (pending.kind === 'custom' && connection.client_id_custom && connection.client_id === pending.id) return null
  if (pending.kind === 'own' && !connection.client_id_custom) return null
  return pending
}

/** What the row says without inventing a value: asking, none configured, the
 *  build's own, or a self-hoster's own (Y-393). The phone board takes the
 *  same shorter strings the GitHub row above it does (row 114). */
function githubAppSupporting(connection: Connection | undefined, phone: boolean, pending: AppPending): string {
  if (pending?.kind === 'custom') return 'Your own · after yantrad restarts'
  if (pending?.kind === 'own') return "Yantra's own · after yantrad restarts"
  if (connection === undefined) return 'asking the daemon'
  if (connection.client_id === null) return phone ? 'None set up' : 'None configured'
  if (connection.client_id_custom) return phone ? 'Your own' : `Your own · ${connection.client_id}`
  return phone ? "Yantra's own" : `Yantra's own · ${connection.client_id}`
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
          <Text render={<p />} scale="body-medium" tone="error" emphasized>
            {logout.error.describe()}
          </Text>
          <Mono className="settings__said">{logout.error.said}</Mono>
        </div>
      ) : null}
    </Sheet>
  )
}

/** Y-393. Nothing here is read back once saved: the daemon takes it at its
 *  next restart, exactly like the relay's own sheet, so a success is a note
 *  rather than a refetch that would still show the old id. `current` is the
 *  custom id in use now, if any — `Clear` is disabled with nothing to remove. */
function ClientIdSheet(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: string | null
  onSaved: (pending: AppPending) => void
}) {
  const { open, onOpenChange, current, onSaved } = props
  const set = useSetGithubClientId()
  const clear = useClearGithubClientId()
  const [saved, setSaved] = useState<'set' | 'cleared' | null>(null)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const id = String(new FormData(event.currentTarget).get('id') ?? '').trim()
    set.mutate(
      { id },
      {
        onSuccess: () => {
          setSaved('set')
          onSaved({ kind: 'custom', id })
        },
      },
    )
  }

  const close = (next: boolean) => {
    if (!next) {
      set.reset()
      clear.reset()
      setSaved(null)
    }
    onOpenChange(next)
  }

  const pending = set.isPending || clear.isPending
  const error = set.error ?? clear.error

  return (
    <Sheet
      description="Use an OAuth App you registered instead of the one Yantra carries. The device flow needs no client secret."
      onOpenChange={close}
      open={open}
      title="Use your own GitHub app"
    >
      <form className="settings__form" id="client-id" onSubmit={submit}>
        <TextField autoComplete="off" label="Client ID" name="id" placeholder="Iv1.…" required type="text" />
        <Text render={<p />} scale="body-small" tone="variant">
          Register one at{' '}
          <a href="https://github.com/settings/applications/new" rel="noreferrer" target="_blank">
            github.com/settings/applications/new
          </a>
          , with Device Flow enabled and "Expire user access tokens" unticked.
        </Text>
        <div aria-live="polite" className="settings__outcome">
          {saved === 'set' ? (
            <Text render={<p />} scale="body-medium" emphasized>
              Saved. yantrad takes it at its next restart —{' '}
              <Mono>sudo systemctl restart yantrad</Mono>.
            </Text>
          ) : null}
          {saved === 'cleared' ? (
            <Text render={<p />} scale="body-medium" emphasized>
              Cleared. yantrad falls back to its own app at its next restart.
            </Text>
          ) : null}
          {error ? (
            <>
              <Text render={<p />} scale="body-medium" tone="error" emphasized>
                {error.describe()}
              </Text>
              <Mono className="settings__said">{error.said}</Mono>
            </>
          ) : null}
        </div>
        <div className="m3-dialog__actions">
          <Button onClick={() => close(false)} variant="text">
            {saved ? 'Done' : 'Cancel'}
          </Button>
          <Button
            disabled={pending || current === null}
            onClick={() =>
              clear.mutate(undefined, {
                onSuccess: () => {
                  setSaved('cleared')
                  onSaved({ kind: 'own' })
                },
              })
            }
            tone="error"
            type="button"
            variant="tonal"
          >
            {clear.isPending ? 'Clearing…' : 'Clear'}
          </Button>
          <Button disabled={pending} type="submit">
            {set.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
