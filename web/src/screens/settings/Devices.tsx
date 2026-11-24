import { Eye, KeyRound, Laptop, LogOut, Plus } from 'lucide-react'
import {
  useDevices,
  useEnrolCode,
  useReadOnlySession,
  useRemovePasskey,
  useSignOut,
  useSignOutOthers,
  type DeviceSession,
} from '@/api/passkey'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Lead } from '@/m3/lead/Lead'
import { ListItem } from '@/m3/list/List'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Num } from '@/m3/text/Text'
import type { ApiError } from '@/api/errors'
import { day } from '@/lib/time'
import { Group } from './Group'

const when = (seconds: number) => day(new Date(seconds * 1000))

/** A write's failure as its own row under the one it failed on, with the
 *  daemon's words behind Details. */
function Failed(props: { title: string; error: ApiError }) {
  return (
    <li className="devices__failed">
      <ErrorSurface.Inline error={props.error} folded title={props.title} />
    </li>
  )
}

/** An empty group's one row, so the group still reads as a list with nothing
 *  in it rather than a label over a caption. */
function Empty(props: { title: string; children: string }) {
  return (
    <li>
      <EmptyState compact title={props.title}>
        {props.children}
      </EmptyState>
    </li>
  )
}

function Session(props: { session: DeviceSession }) {
  const { session } = props
  const out = useSignOut()
  return (
    <>
      <ListItem
        headline={session.device}
        leading={
          session.read_only ? (
            <Lead tone="tertiary">
              <Eye />
            </Lead>
          ) : (
            <Lead tone={session.this_device ? 'primary' : undefined}>
              <Laptop />
            </Lead>
          )
        }
        supporting={
          <>
            {session.read_only ? 'reads only' : `${session.this_device ? 'this device · ' : ''}with ${session.passkey}`}
            {' · ends '}
            <Num>{when(session.ends)}</Num>
          </>
        }
        trailing={
          <Button variant="text" tone="error" onClick={() => out.mutate(session.id)} disabled={out.isPending}>
            Sign out
          </Button>
        }
      />
      {out.error ? <Failed error={out.error} title={`${session.device} was not signed out`} /> : null}
    </>
  )
}

function Passkey(props: { name: string; made: number }) {
  const { name, made } = props
  const remove = useRemovePasskey()
  return (
    <>
      <ListItem
        headline={name}
        leading={
          <Lead>
            <KeyRound />
          </Lead>
        }
        supporting={
          <>
            enrolled <Num>{when(made)}</Num>
          </>
        }
        trailing={
          <Button variant="text" tone="error" onClick={() => remove.mutate(name)} disabled={remove.isPending}>
            Remove
          </Button>
        }
      />
      {remove.error ? <Failed error={remove.error} title={`${name} was not removed`} /> : null}
    </>
  )
}

function NewDevice(props: { first: boolean }) {
  const code = useEnrolCode()
  return (
    <Group
      label="Add a device"
      note="On the new device, open the dashboard, choose Set up this device with a code, and type the code. It works once, within 10 minutes."
    >
      <ListItem
        headline={props.first ? 'A code for the first device' : 'A code for one new device'}
        leading={
          <Lead tone="primary">
            <Plus />
          </Lead>
        }
        supporting="or run yantra passkey code on the hub"
        trailing={
          <Button variant="tonal" onClick={() => code.mutate()} disabled={code.isPending}>
            {code.data ? 'New code' : 'Make a code'}
          </Button>
        }
      />
      {code.error ? <Failed error={code.error} title="No code was made" /> : null}
      {code.data ? <Copyable text={code.data.code} what="the code" /> : null}
    </Group>
  )
}

/** ADR-0044's note of 2026-11-24: a session that reads and changes nothing,
 *  for the build loop's look at this hub. Its token shows once, here. */
function ReadOnly() {
  const made = useReadOnlySession()
  return (
    <Group
      label="Read-only session"
      note={
        made.data ? (
          <>
            This token shows once. Save it on the laptop as <Mono>~/.config/yantra/walk-session</Mono> with mode 600.
          </>
        ) : (
          'It reads this dashboard from your own devices for 30 days and changes nothing. The build loop looks at this hub with it.'
        )
      }
    >
      <ListItem
        headline="A session that only reads"
        leading={
          <Lead tone="tertiary">
            <Eye />
          </Lead>
        }
        supporting="or run yantra session read walk on the hub"
        trailing={
          <Button variant="tonal" onClick={() => made.mutate()} disabled={made.isPending}>
            {made.data ? 'Make another' : 'Make a token'}
          </Button>
        }
      />
      {made.error ? <Failed error={made.error} title="No read-only session was made" /> : null}
      {made.data ? <Copyable text={made.data.token} what="the token" /> : null}
    </Group>
  )
}

/** ADR-0044 decision 9: the passkeys, the devices they signed in, and the
 *  ways to end each one. */
export function Devices() {
  const devices = useDevices()
  const others = useSignOutOthers()
  if (devices.error) {
    return (
      <ErrorSurface
        eyebrow="Devices read"
        title="The devices could not be read"
        error={devices.error}
        reset={() => void devices.refetch()}
      />
    )
  }
  if (!devices.data) {
    return (
      <Group label="Passkeys">
        <li aria-busy="true">
          <Skeleton shape="row" />
        </li>
      </Group>
    )
  }
  const { passkeys, sessions, relying_party } = devices.data
  const at = relying_party ? `Passkeys work at ${relying_party}.` : undefined
  // Y-687: with no passkey the one thing to do is enrol the first device, so
  // it leads and the groups that cannot have rows yet stay out of the way.
  if (passkeys.length === 0) {
    return (
      <>
        <NewDevice first />
        <Group label="Passkeys" note={at}>
          <Empty title="No passkey yet">Make a code to enrol the first device.</Empty>
        </Group>
      </>
    )
  }
  return (
    <>
      <Group label="Signed in" note={at}>
        {sessions.length === 0 ? (
          <Empty title="No device is signed in">A device signs in when it uses its passkey here.</Empty>
        ) : (
          sessions.map((session) => <Session key={session.id} session={session} />)
        )}
      </Group>
      {sessions.some((one) => !one.this_device) ? (
        <Button
          variant="outlined"
          tone="error"
          icon={<LogOut />}
          onClick={() => others.mutate()}
          disabled={others.isPending}
        >
          Sign out every other device
        </Button>
      ) : null}
      {others.error ? (
        <ErrorSurface.Inline error={others.error} folded title="The other devices were not signed out" />
      ) : null}
      <Group label="Passkeys" note="Removing a passkey signs out every device it signed in.">
        {passkeys.map((one) => (
          <Passkey key={one.name} name={one.name} made={one.made} />
        ))}
      </Group>
      <NewDevice first={false} />
      <ReadOnly />
    </>
  )
}
