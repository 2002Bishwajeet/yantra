import { Bot } from 'lucide-react'
import { useReadiness } from '@/api/hooks'
import { Lead } from '@/m3/lead/Lead'
import { ListItem } from '@/m3/list/List'
import { Group, Note } from './Group'
import { onMachines, presentOn } from './readiness'

export function Agents() {
  const readiness = useReadiness()
  return (
    <>
      <Group label="Installed">
        <ListItem
          headline="Claude Code"
          leading={
            <Lead tone="primary">
              <Bot />
            </Lead>
          }
          supporting={`Default · ${onMachines(presentOn(readiness, 'agent-cli'), 'present')} · You answer its questions here`}
        />
      </Group>
      <Note>Each machine keeps its own agent settings. Change them on that machine.</Note>
    </>
  )
}
