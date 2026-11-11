import { useMachines } from '@/api/hooks'
import { useEnterSends } from '@/composer/enterSends'
import { Button } from '@/m3/button/Button'
import { ListItem } from '@/m3/list/List'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { Switch } from '@/m3/switch/Switch'
import { readPrefs, usePrefs, writePrefs } from '@/shell/prefs'
import { setupCardHidden, showSetupCard } from '@/screens/dashboard/setupCard'
import { Group, Note } from './Group'
import { CLONE_HOMES, type General as Held, readGeneral } from './general'

// `writePrefs` merges one level deep, so General's keys are read again at the
// write rather than held from the render that drew the row. The keys no row
// here edits, such as the setup card's, are kept.
function write(patch: Partial<Held>) {
  const prefs = readPrefs()
  writePrefs({ general: { ...prefs.general, ...readGeneral(prefs), ...patch } })
}

export function General() {
  const prefs = usePrefs()
  const held = readGeneral(prefs)
  const enterSends = useEnterSends()
  const machines = useMachines()
  const names = machines.looked === 'ok' ? machines.data.map((one) => one.name) : []
  // A machine the list no longer has still shows as chosen: it is what was
  // written, and the Where step will say it is gone.
  const options = held.defaultMachine && !names.includes(held.defaultMachine) ? [held.defaultMachine, ...names] : names

  return (
    <>
      <Group label="New session">
        <ListItem
          headline="Home directory for clones"
          supporting="Where a clone lands on the machine"
          trailing={
            <Segmented label="Home directory for clones" onValueChange={(value) => write({ cloneHome: value as Held['cloneHome'] })} value={held.cloneHome}>
              {CLONE_HOMES.map((one) => (
                <Segment key={one} value={one}>
                  {one}
                </Segment>
              ))}
            </Segmented>
          }
        />
        <ListItem
          headline="Default machine for new sessions"
          supporting="Preselected in New session when reachable"
          trailing={
            <select
              aria-label="Default machine for new sessions"
              className="settings__select"
              onChange={(event) => write({ defaultMachine: event.target.value || null })}
              value={held.defaultMachine ?? ''}
            >
              <option value="">none</option>
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          }
        />
      </Group>
      <Group label="Chat">
        <ListItem
          headline="Enter sends"
          supporting="Off: Ctrl or Cmd+Enter sends"
          trailing={<Switch checked={enterSends} label="Enter sends" onCheckedChange={(on) => write({ enterSends: on })} />}
        />
      </Group>
      <Group label="Dashboard">
        <ListItem
          headline="Time format"
          supporting="Age: 12m, 6h. Clock: wall time"
          trailing={
            <Segmented label="Time format" onValueChange={(value) => write({ time: value as Held['time'] })} value={held.time}>
              <Segment value="age">Age</Segment>
              <Segment value="clock">Clock</Segment>
            </Segmented>
          }
        />
        {setupCardHidden(prefs) ? (
          <ListItem
            headline="Finish setup card"
            supporting="Hidden from the dashboard"
            trailing={
              <Button onClick={showSetupCard} variant="text">
                Show the setup card
              </Button>
            }
          />
        ) : null}
      </Group>
      <Note>Saved on this device. How the dashboard looks is under Appearance.</Note>
    </>
  )
}
