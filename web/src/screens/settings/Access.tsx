import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { KeyRound, Network, Shield } from 'lucide-react'
import { useAbout, useSshIdentity } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { Lead } from '@/m3/lead/Lead'
import { ListItem, ListValue } from '@/m3/list/List'
import { Mono } from '@/m3/text/Text'
import { Group, Note } from './Group'
import { Sheet } from './Sheet'
import './Access.css'

export function Access() {
  const identity = useSshIdentity()
  const about = useAbout()
  const [open, setOpen] = useState(false)
  // `null` is a key not yet made, which is a state of the row; an error is
  // the boundary's.
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
            className="access__wrap"
            headline="SSH identity"
            leading={
              <Lead>
                <KeyRound />
              </Lead>
            }
            supporting={key === null ? 'Made when the first machine joins' : 'asking the daemon'}
            trailing={
              key === null ? (
                <Button render={<Link to="/machines/add" />} role="link" variant="text">
                  Add a device
                </Button>
              ) : undefined
            }
          />
        )}
      </Group>
      <Group label="Who may open the dashboard">
        <ListItem
          className="access__wrap"
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
          className="access__wrap"
          headline={listening.length === 1 ? 'Listen address' : 'Listen addresses'}
          leading={
            <Lead>
              <Network />
            </Lead>
          }
          supporting="tailnet addresses only · not on the LAN and not on a public port"
          trailing={
            <ListValue>
              {listening.length ? (
                <span className="access__addresses">
                  {listening.map((one) => (
                    <Mono key={one}>{one}</Mono>
                  ))}
                </span>
              ) : (
                '…'
              )}
            </ListValue>
          }
        />
      </Group>
      <Note>
        The daemon itself keeps two credentials, the relay token and the GitHub grant, in one file on the appliance. They
        are under Notifications and Providers.
      </Note>
      {key ? <KeySheet onOpenChange={setOpen} open={open} publicKey={key.public_key} /> : null}
    </>
  )
}

function KeySheet(props: { open: boolean; onOpenChange: (open: boolean) => void; publicKey: string }) {
  const { open, onOpenChange, publicKey } = props
  return (
    <Sheet
      actions={
        <Button onClick={() => onOpenChange(false)} variant="text">
          Close
        </Button>
      }
      description="The join command places this key for you. To place it by hand, add it to ~/.ssh/authorized_keys on the machine."
      onOpenChange={onOpenChange}
      open={open}
      title="Public key"
    >
      <Copyable text={publicKey} what="the public key" />
    </Sheet>
  )
}
