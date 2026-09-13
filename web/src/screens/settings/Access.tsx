import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { KeyRound, Network, Plus, Shield } from 'lucide-react'
import { useAbout, useSshIdentity } from '@/api/hooks'
import { joinUrl } from '@/lib/join'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { Lead } from '@/m3/lead/Lead'
import { ListItem, ListValue } from '@/m3/list/List'
import { Mono } from '@/m3/text/Text'
import { Join } from '@/screens/setup/Join'
import { Group, Note } from './Group'
import { Sheet } from './Sheet'

const addDevice = (
  <Button icon={<Plus />} render={<Link to="/add" />} role="link" variant="tonal">
    Add a device
  </Button>
)

export function Access() {
  const identity = useSshIdentity()
  const about = useAbout()
  const [open, setOpen] = useState(false)
  // `null` is a key not yet made, which is a state of the row; an error is
  // the boundary's.
  const missing = identity.data === null
  if (identity.error) throw identity.error
  if (about.error) throw about.error
  const key = identity.data
  const tailnet = about.data?.tailnet ?? null
  const listening = about.data?.listening_on ?? []

  return (
    <>
      <Group
        label="SSH identity"
        note="A new machine takes this key through the join command, which Add a device shows. The private key never leaves the appliance."
      >
        {key ? (
          <ListItem
            headline={<Mono>{key.path}</Mono>}
            leading={
              <Lead>
                <KeyRound />
              </Lead>
            }
            supporting={`${key.kind} · ${key.fingerprint} · the daemon uses it to reach every machine`}
            trailing={
              <Button onClick={() => setOpen(true)} variant="text">
                Show key
              </Button>
            }
          />
        ) : (
          <ListItem
            headline="SSH identity"
            leading={
              <Lead>
                <KeyRound />
              </Lead>
            }
            supporting={missing ? 'not created yet · the first machine that joins makes it' : 'asking the daemon'}
            trailing={missing ? addDevice : undefined}
          />
        )}
      </Group>
      <Group label="Who may open the dashboard">
        <ListItem
          headline={tailnet ? `Anyone on the tailnet ${tailnet}` : 'Anyone on the tailnet'}
          leading={
            <Lead>
              <Shield />
            </Lead>
          }
          supporting={
            tailnet
              ? 'Tailscale is the door · a device outside the tailnet gets nothing'
              : "Tailscale is the door · the tailnet's name arrives with the first look at the machines"
          }
          trailing={<ListValue>tailscale · on</ListValue>}
        />
        <ListItem
          headline={listening.length === 1 ? 'Listen address' : 'Listen addresses'}
          leading={
            <Lead>
              <Network />
            </Lead>
          }
          supporting="tailnet addresses only · not on the LAN and not on a public port"
          trailing={<ListValue>{listening.length ? <Mono>{listening.join(' · ')}</Mono> : '…'}</ListValue>}
        />
      </Group>
      <Note>
        The daemon itself keeps two credentials, the relay token and the GitHub grant, in one file on the appliance. They
        are under Notifications and Providers.
      </Note>
      {key ? <KeySheet about={about} onOpenChange={setOpen} open={open} publicKey={key.public_key} /> : null}
    </>
  )
}

function KeySheet(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  publicKey: string
  about: { error: Error | null; data: Parameters<typeof joinUrl>[1] }
}) {
  const { open, onOpenChange, publicKey, about } = props
  return (
    <Sheet
      actions={
        <>
          {addDevice}
          <Button onClick={() => onOpenChange(false)} variant="text">
            Close
          </Button>
        </>
      }
      description="A new machine takes this key through the join command. Run it once in a terminal on that machine; Add a device shows the steps for each platform."
      onOpenChange={onOpenChange}
      open={open}
      title="Public key"
    >
      <Join about={about} url={joinUrl(location, about.data)} what="the join command" />
      <Copyable text={publicKey} what="the public key" />
    </Sheet>
  )
}
