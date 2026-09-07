import { useState } from 'react'
import { Check, Copy, KeyRound, Network, Shield } from 'lucide-react'
import { isApiError } from '@/api/errors'
import { useAbout, useSshIdentity } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { Lead } from '@/m3/lead/Lead'
import { ListItem, ListValue } from '@/m3/list/List'
import { Mono } from '@/m3/text/Text'
import { Group, Note } from './Group'
import { Sheet } from './Sheet'

export function Access() {
  const identity = useSshIdentity()
  const about = useAbout()
  const [open, setOpen] = useState(false)
  // 404 is a key not yet made, which is a state of the row; anything else is
  // the boundary's.
  const missing = isApiError(identity.error) && identity.error.kind === 'missing'
  if (identity.error && !missing) throw identity.error
  if (about.error) throw about.error
  const key = identity.data
  const tailnet = about.data?.tailnet ?? null
  const listening = about.data?.listening_on ?? []

  return (
    <>
      <Group
        label="SSH identity"
        note="The public key is shown in the sheet so you can paste it into a new machine. The private key never leaves the appliance."
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
            supporting={
              missing ? (
                <>
                  not created · run <Mono>yantra ssh-identity</Mono> on the appliance
                </>
              ) : (
                'asking the daemon'
              )
            }
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
      {key ? <KeySheet onOpenChange={setOpen} open={open} publicKey={key.public_key} /> : null}
    </>
  )
}

function KeySheet(props: { open: boolean; onOpenChange: (open: boolean) => void; publicKey: string }) {
  const { open, onOpenChange, publicKey } = props
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(publicKey).then(() => setCopied(true))
  }
  return (
    <Sheet
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} variant="text">
            Close
          </Button>
          <Button icon={copied ? <Check /> : <Copy />} onClick={copy} variant="tonal">
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </>
      }
      description="Paste this line into ~/.ssh/authorized_keys on a machine the daemon should reach."
      onOpenChange={(next) => {
        if (!next) setCopied(false)
        onOpenChange(next)
      }}
      open={open}
      title="Public key"
    >
      <pre className="settings__key">{publicKey}</pre>
    </Sheet>
  )
}
