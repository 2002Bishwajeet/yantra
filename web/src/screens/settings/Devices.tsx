import { KeyRound, Laptop, LogOut, Plus } from 'lucide-react'
import {
  useDevices,
  useEnrolCode,
  useRemovePasskey,
  useSignOut,
  useSignOutOthers,
  type DeviceSession,
} from '@/api/passkey'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Lead } from '@/m3/lead/Lead'
import { ListItem } from '@/m3/list/List'
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

function Session(props: { session: DeviceSession }) {
  const { session } = props
  const out = useSignOut()
  return (
    <>
      <ListItem
        headline={session.device}
        leading={
          <Lead tone={session.this_device ? 'primary' : undefined}>
            <Laptop />
          </Lead>
        }
        supporting={`${session.this_device ? 'this device · ' : ''}with ${session.passkey} · ends ${when(session.ends)}`}
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
        supporting={`enrolled ${when(made)}`}
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

function NewDevice() {
  const code = useEnrolCode()
  return (
    <Group
      label="Add a device"
      note="On the new device, open the dashboard, choose Set up this device with a code, and type the code. It works once, within 10 minutes."
    >
      <ListItem
        headline="A code for one new device"
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
  const passkeys = devices.data?.passkeys ?? []
  const sessions = devices.data?.sessions ?? []
  return (
    <>
      <Group label="Signed in" note={devices.data?.relying_party ? `Passkeys work at ${devices.data.relying_party}.` : undefined}>
        {sessions.map((session) => (
          <Session key={session.id} session={session} />
        ))}
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
      <NewDevice />
    </>
  )
}
