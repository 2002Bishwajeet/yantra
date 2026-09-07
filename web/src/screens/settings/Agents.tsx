import { Bot, Plus } from 'lucide-react'
import { useReadiness } from '@/api/hooks'
import { Chip } from '@/m3/chip/Chip'
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
          supporting={`${onMachines(presentOn(readiness, 'agent-cli'), 'present')} · trust prompts are answered from the dashboard`}
          trailing={<Chip tone="primary">Default</Chip>}
        />
      </Group>
      <Group label="Coming">
        <ListItem
          headline="Another agent"
          leading={
            <Lead>
              <Plus />
            </Lead>
          }
          supporting="later · the Start step of New session grows a card when one is wired"
        />
      </Group>
      <Note>How an agent behaves is set on the machine that runs it; the daemon holds no switch for it.</Note>
    </>
  )
}
