import { useState } from 'react'
import type { Listed, Workspace } from '@/api'
import { Answer } from '@/components/Spend'
import { Section } from '@/components/Section'
import { Title } from '@/components/Title'
import { nativeSelect } from '@/lib/control'
import { type Asked, read } from '@/lib/spend'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { loaded, useLooked } from '@/useLooked'

/** D3 §11.4, with one correction the daemon made first: spend is per
 *  **workspace**, not per machine. `yantra tokens` loads a workspace and finds
 *  its transcript, so a per-machine figure would need either the fan-out §11.4
 *  forbids or CLI surface that does not exist.
 *
 *  Everything else §11.4 asks for holds. The page opens holding a picker and
 *  nothing else, the figure is read on request, and nothing polls it — the read
 *  opens a transcript over ssh, which is why Y-181 made it its own verb.
 *
 *  **The picker is all this route adds.** `Answer` and `Figure` are
 *  [`components/Spend.tsx`](../components/Spend.tsx)'s, so `/w/{name}`'s spend
 *  tab draws the same figure against the workspace in its URL
 *  ([D5](../../../docs/design/05-workspace-page.md) §6.1). */
export function Usage() {
  const workspaces = loaded(useLooked<Listed[]>('/api/workspaces'))
  // Above the `Section` rather than inside it: a workspaces poll that fails
  // once would otherwise take the answer you asked for off the screen with it.
  const [asked, setAsked] = useState<Asked>({ asked: 'no' })

  const ask = async (workspace: Workspace) => {
    setAsked({ asked: 'asking', workspace })
    setAsked(await read(workspace))
  }

  return (
    <>
      <Title>Usage</Title>
      <p className="text-muted-foreground max-w-prose text-sm">
        A workspace's spend is counted from the transcript on the machine that
        wrote it, over ssh. Nothing here polls: you pick a workspace and ask.
        There is no fleet total, because one would read every workspace's
        transcript the moment this page opened.
      </p>

      <Section query={workspaces} title="Which workspace">
        {(rows) => (
          <Pick
            asking={asked.asked === 'asking'}
            onAsk={(workspace) => void ask(workspace)}
            workspaces={rows}
          />
        )}
      </Section>

      <Answer asked={asked} />
    </>
  )
}

function Pick({
  workspaces,
  asking,
  onAsk,
}: {
  workspaces: Workspace[]
  asking: boolean
  onAsk: (workspace: Workspace) => void
}) {
  const [chosen, setChosen] = useState('')
  const one = workspaces.find((workspace) => workspace.name === chosen)

  if (workspaces.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            no workspace loaded, so there is no transcript to add up
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (one) onAsk(one)
      }}
    >
      <div className="flex w-full max-w-xs flex-col items-start gap-2">
        {/* Hand-rolled against D3 §7.4, and §9.1 is what buys it: measured on
            this route, `ui/field` costs 7.58 kB gzip and `ui/label` 0.43 kB.
            One control, one label, and no ring to lose. */}
        <label className="text-sm font-medium" htmlFor="usage-workspace">
          Workspace
        </label>
        <select
          className={nativeSelect}
          id="usage-workspace"
          name="workspace"
          onChange={(event) => setChosen(event.target.value)}
          required
          value={chosen}
        >
          <option disabled value="">
            choose a workspace
          </option>
          {workspaces.map((workspace) => (
            <option key={workspace.name} value={workspace.name}>
              {workspace.name} — {workspace.machine}
            </option>
          ))}
        </select>
      </div>
      <Button disabled={asking || !one} type="submit">
        {asking ? 'reading…' : 'Read spend'}
      </Button>
    </form>
  )
}
