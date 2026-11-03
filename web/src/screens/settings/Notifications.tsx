import { useState } from 'react'
import { Bell, BellRing, CircleSlash, MoonStar, SquareCheck } from 'lucide-react'
import { useAbout } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { Lead } from '@/m3/lead/Lead'
import { ListItem, ListValue } from '@/m3/list/List'
import { Group, Note } from './Group'
import { PushSetup } from './PushSetup'

/** What `notify::Watch` sends, in the daemon's own terms. The daemon decides
 *  what is worth a push, and no route changes it, so these read rather than
 *  set. The third row is not sent because a look that failed is not a change
 *  (I-47). */
const WHEN = [
  {
    icon: <BellRing />,
    headline: 'When an agent needs you',
    supporting: 'a trust prompt, and only the first time one appears',
    sent: true,
  },
  {
    icon: <SquareCheck />,
    headline: 'When a session ends',
    supporting: 'finished, crashed with its exit code, killed by a signal, or gone',
    sent: true,
  },
  {
    icon: <CircleSlash />,
    headline: 'When a machine goes unreachable',
    supporting: 'a look the daemon could not make is not a change it can report',
    sent: false,
  },
]

/** `about.relay` says whether the running daemon holds one; `saved` says a
 *  save happened in this session (§B4: nothing reads the relay itself back,
 *  so a save cannot move `relay` until yantrad restarts and this page is read
 *  again, ADR-0021). */
function relaySupporting(relay: boolean | undefined, saved: boolean): string {
  if (relay === undefined) return 'asking the daemon'
  const base = relay ? 'On · the daemon holds a relay and pushes to it' : 'Off · nothing is pushed'
  return saved ? `${base} · saved, used after yantrad restarts` : base
}

export function Notifications() {
  const about = useAbout()
  const [savedAtUptime, setSavedAtUptime] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  // The restart is a moment with no daemon; the facts already drawn stay.
  if (about.error && !(savedAtUptime !== null && about.data)) throw about.error

  // uptime_seconds only grows while yantrad runs and resets on a restart, so
  // a read lower than the value at save time proves the restart happened —
  // the daemon is now running with whatever this page last wrote, and the
  // note has done its job. A steady climb (still the same process) never
  // triggers it, including a save that changes nothing (on -> on).
  const saved = savedAtUptime !== null && (about.data === undefined || about.data.uptime_seconds >= savedAtUptime)

  return (
    <>
      <Group label="Relay">
        <ListItem
          headline="Push relay"
          leading={
            <Lead>
              <Bell />
            </Lead>
          }
          supporting={relaySupporting(about.data?.relay, saved)}
          trailing={
            <Button onClick={() => setOpen(true)} variant="text">
              {about.data?.relay === false ? 'Set up' : 'Edit'}
            </Button>
          }
        />
      </Group>
      <Group
        label="Push when"
        note="The daemon decides what is worth a push; there is no route that changes this, so these read rather than set."
      >
        {WHEN.map((one) => (
          <ListItem
            headline={one.headline}
            key={one.headline}
            leading={<Lead tone={one.sent ? 'primary' : undefined}>{one.icon}</Lead>}
            supporting={one.supporting}
            trailing={<ListValue>{one.sent ? 'Sent' : 'Not sent'}</ListValue>}
          />
        ))}
      </Group>
      <Group label="Quiet">
        <ListItem
          headline="Quiet while a dashboard is open"
          leading={
            <Lead>
              <MoonStar />
            </Lead>
          }
          supporting="the daemon knows when a browser is looking"
          trailing={<ListValue>Always</ListValue>}
        />
      </Group>
      <Note>An open dashboard tells the daemon so every 20 seconds, and the push stops while one is.</Note>
      <PushSetup onOpenChange={setOpen} onSaved={() => setSavedAtUptime(about.data?.uptime_seconds ?? 0)} open={open} />
    </>
  )
}
