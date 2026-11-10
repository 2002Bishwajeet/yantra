import { RefreshCw } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { Machine } from '@/api'
import { fromReading } from '@/api/client'
import { useAbout, useMachines } from '@/api/hooks'
import { keys } from '@/api/keys'
import { LOGIN_SERVER_COMMAND, noLoginServer } from '@/lib/checks'
import { joinCommand, joinUrl } from '@/lib/join'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { FilterChip } from '@/m3/chip/Chip'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { IconButton } from '@/m3/icon-button/IconButton'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { Tile } from '@/m3/tile/Tile'
import { useReports } from '@/screens/setup/progress'
import { nameError, type Values } from './form'
import { SuggestMachine } from './Suggestion'
import { useOffered } from './useOffered'
import type { SessionForm } from './useSessionForm'
import { generateName } from './words'

/** Unknown is not absent (R-23): a missing report, or a sweep that failed, warns of nothing. */
function LoginServerWarning(props: { machines: Machine[]; chosen: string }) {
  const { machines, chosen } = props
  const reports = useReports(machines)
  const report = reports[machines.findIndex((one) => one.name === chosen)]
  const absent = report?.checks.some(
    (one) =>
      (one.check === 'login-session' || one.check === 'provider-auth') &&
      one.state === 'absent' &&
      noLoginServer(one.detail),
  )
  if (!absent) return null
  return (
    <div className="ns__fix" role="status">
      <Text render={<p />} className="ns__note" scale="body-medium">
        {chosen} has no tmux server from a login session, so a session cannot start there yet. In Terminal on{' '}
        {chosen}, run:
      </Text>
      <Copyable text={LOGIN_SERVER_COMMAND} what="the Terminal command that starts a login tmux server" />
    </div>
  )
}

/** Y-627: the hub is the daemon's own host. It gets no chip until an account
 *  on it has joined, and this says how to make one. */
function HubJoin(props: { name: string }) {
  const { name } = props
  const url = joinUrl(location, useAbout().data)
  return (
    <Text render={<div role="note" />} className="ns__note" scale="body-medium" tone="variant">
      <p>
        {name} runs sessions after an account on it joins. Make a separate account without sudo on {name}, named
        karigar, log in to it there, and run the join command.
      </p>
      {url ? <Copyable text={joinCommand(url)} what="the join command" /> : null}
      <Button render={<Link params={{ machine: name }} to="/m/$machine" />} role="link" variant="text">
        Open
      </Button>
    </Text>
  )
}

function Machines(props: { form: SessionForm; values: Values; preset: string }) {
  const { form, values, preset } = props
  const machines = useMachines()
  const client = useQueryClient()
  const { yours, shown, waiting } = useOffered()
  const hub = yours.find((one) => one.hub && !shown.includes(one))
  // The hub's chip waits on readiness, so a read still in flight draws the skeleton rather than a chip that pops in.
  if (machines.looked === 'pending' || waiting) {
    return (
      <div aria-busy="true" className="ns__chips">
        <Skeleton shape="text" style={{ width: 120 }} />
        <Skeleton shape="text" style={{ width: 96 }} />
        <Skeleton shape="text" style={{ width: 72 }} />
      </div>
    )
  }
  if (machines.looked !== 'ok') {
    return (
      <ErrorSurface.Inline
        error={
          fromReading(machines) ?? {
            kind: 'network',
            said: '',
            retryable: false,
            describe: () => 'The machines have not been looked at yet, so none can be chosen.',
          }
        }
        reset={() => void client.invalidateQueries({ queryKey: keys.machines() })}
        title="Machines could not be read"
      />
    )
  }
  return (
    <>
      <div aria-label="Machine" className="ns__chips" role="group">
        {/* Y-404: a node another owner holds is not a place to run sessions. */}
        {shown.map((one) => {
          const reachable = one.online && !one.expired
          return (
            <FilterChip
              disabled={!reachable}
              key={one.name}
              onPressedChange={(pressed) => {
                if (!pressed) return
                form.setFieldValue('machine', one.name)
                // A path is a fact about one machine.
                form.setFieldValue('source', null)
              }}
              pressed={values.machine === one.name}
            >
              {reachable ? one.name : `${one.name} · unreachable`}
            </FilterChip>
          )
        })}
      </div>
      {hub ? <HubJoin name={hub.name} /> : null}
      <SuggestMachine form={form} machines={shown} preset={preset} values={values} />
      <LoginServerWarning chosen={values.machine} machines={machines.data} />
    </>
  )
}

/** Step 1: the name, its tile, and the machine (NewSession, PhoneNewSessionName). */
export function StepName(props: { form: SessionForm; values: Values; preset: string }) {
  const { form, values, preset } = props
  return (
    <Card className="ns__card">
      <Eyebrow render={<h2 />}>Name</Eyebrow>
      <div className="ns__name">
        <Tile className="ns__preview" name={values.name || '?'} />
        <form.Field name="name" validators={{ onChange: ({ value }) => nameError(value) }}>
          {(field) => {
            const error = field.state.meta.errorMap.onChange
            return (
              <TextField
                autoComplete="off"
                className="ns__field"
                error={typeof error === 'string' ? error : undefined}
                label="Name"
                onBlur={field.handleBlur}
                onValueChange={(value) => {
                  field.handleChange(value)
                  form.setFieldValue('named', true)
                }}
                supporting={
                  <>
                    Optional. Leave it and the session is called {values.name || 'what you type'};
                    the letter and colour are how you tell sessions apart at a glance.
                  </>
                }
                trailing={
                  <IconButton
                    label="Another name"
                    onClick={() => {
                      field.handleChange(generateName())
                      form.setFieldValue('named', false)
                    }}
                  >
                    <RefreshCw />
                  </IconButton>
                }
                value={field.state.value}
              />
            )
          }}
        </form.Field>
      </div>

      <Eyebrow render={<h2 />}>Machine</Eyebrow>
      <Machines form={form} preset={preset} values={values} />
      <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
        The session runs here. Yantra looks for the repository on this machine in the next step.
      </Text>
    </Card>
  )
}
