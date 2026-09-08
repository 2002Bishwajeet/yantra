import { useMachines } from '@/api/hooks'
import { ListItem, ListValue } from '@/m3/list/List'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { readPrefs, usePrefs, writePrefs } from '@/shell/prefs'
import { Group, Note } from './Group'
import { CLONE_HOMES, type General as Held, readGeneral } from './general'

// `writePrefs` merges one level deep, so General's keys are read again at the
// write rather than held from the render that drew the row.
function write(patch: Partial<Held>) {
  writePrefs({ general: { ...readGeneral(readPrefs()), ...patch } })
}

export function General() {
  const held = readGeneral(usePrefs())
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
          supporting="a clone lands under one of these on the machine you pick"
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
          supporting="preselected in the Machine step"
          trailing={
            <select
              aria-label="Default machine for new sessions"
              className="settings__select"
              onChange={(event) => write({ defaultMachine: event.target.value || null })}
              value={held.defaultMachine ?? ''}
            >
              <option value="">first in the list</option>
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          }
        />
      </Group>
      <Group label="Dashboard">
        <ListItem
          headline="Time format"
          supporting="Age shows 4s, 12m, 6h and a date past a day · Clock shows the wall time"
          trailing={
            <Segmented label="Time format" onValueChange={(value) => write({ time: value as Held['time'] })} value={held.time}>
              <Segment value="age">Age</Segment>
              <Segment value="clock">Clock</Segment>
            </Segmented>
          }
        />
        <ListItem
          headline="Confirmations"
          supporting="Kill and Delete ask first because they cannot be undone. Stop and Resume do not."
          trailing={<ListValue>fixed</ListValue>}
        />
        <ListItem headline="Language" supporting="the dashboard and the notifications it sends" trailing={<ListValue>English</ListValue>} />
      </Group>
      <Note>Saved on this device. How the dashboard looks is under Appearance.</Note>
    </>
  )
}
