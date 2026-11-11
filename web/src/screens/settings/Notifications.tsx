import { useState } from 'react'
import { Bell } from 'lucide-react'
import { useAbout } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { Lead } from '@/m3/lead/Lead'
import { ListItem } from '@/m3/list/List'
import { Group, Note } from './Group'
import { PushSetup } from './PushSetup'

/** `about.relay` says whether the running daemon holds one; `saved` says a
 *  save happened in this session (§B4: nothing reads the relay itself back,
 *  so a save cannot move `relay` until yantrad restarts and this page is read
 *  again, ADR-0021). */
function relaySupporting(relay: boolean | undefined, saved: boolean): string {
  if (relay === undefined) return 'asking the daemon'
  const base = relay ? 'On · pushes to your relay' : 'Off · nothing is pushed'
  return saved ? `${base} · saved, used after a restart` : base
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
      <Note>Yantra pushes when an agent needs you or a session ends. It stays quiet while a dashboard is open.</Note>
      <PushSetup onOpenChange={setOpen} onSaved={() => setSavedAtUptime(about.data?.uptime_seconds ?? 0)} open={open} />
    </>
  )
}
