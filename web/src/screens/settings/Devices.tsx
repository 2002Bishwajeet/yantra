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
import { Group, Note } from './Group'

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function Session(props: { session: DeviceSession }) {
  const { session } = props
  const out = useSignOut()
  return (
    <ListItem
      headline={session.device}
      leading={
        <Lead tone={session.this_device ? 'primary' : undefined}>
          <Laptop />
        </Lead>
      }
      supporting={
        out.error
          ? `${out.error.describe()} ${out.error.said}`
          : `${session.this_device ? 'this device · ' : ''}with ${session.passkey} · ends ${day(session.ends)}`
      }
      trailing={
        <Button variant="text" tone="error" onClick={() => out.mutate(session.id)} disabled={out.isPending}>
          Sign out
        </Button>
      }
    />
  )
}

function Passkey(props: { name: string; made: number }) {
  const { name, made } = props
  const remove = useRemovePasskey()
  return (
    <ListItem
      headline={name}
      leading={
        <Lead>
          <KeyRound />
        </Lead>
      }
      supporting={
        remove.error ? `${remove.error.describe()} ${remove.error.said}` : `enrolled ${day(made)}`
      }
      trailing={
        <Button variant="text" tone="error" onClick={() => remove.mutate(name)} disabled={remove.isPending}>
          Remove
        </Button>
      }
    />
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
        supporting={code.error ? `${code.error.describe()} ${code.error.said}` : 'or run yantra passkey code on the hub'}
        trailing={
          <Button variant="tonal" onClick={() => code.mutate()} disabled={code.isPending}>
            {code.data ? 'New code' : 'Make a code'}
          </Button>
        }
      />
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
      {others.error ? <Note>{`${others.error.describe()} ${others.error.said}`}</Note> : null}
      <Group label="Passkeys" note="Removing a passkey signs out every device it signed in.">
        {passkeys.map((one) => (
          <Passkey key={one.name} name={one.name} made={one.made} />
        ))}
      </Group>
      <NewDevice />
    </>
  )
}
