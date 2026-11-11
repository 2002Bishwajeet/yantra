/*
 * The work log adapts T3 Code's work group rows, which fold a turn's tool calls into one row:
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/TimelineWorkGroupRows.tsx
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/WorkLog.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ItemType } from '@/api/thread'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Mono, Text } from '@/m3/text/Text'
import type { Message, Tool } from './timeline'
import type { Row } from './workLog.logic'

const KIND: Record<ItemType, string> = {
  command_execution: 'Command',
  file_change: 'File change',
  web_search: 'Web',
  dynamic_tool_call: 'Tool',
}

const STATUS: Record<Tool['status'], { state: MarkState; word: string }> = {
  inProgress: { state: 'running', word: 'running' },
  completed: { state: 'done', word: 'done' },
  failed: { state: 'failed', word: 'failed' },
}

function Call(props: { tool: Tool }) {
  const { tool } = props
  const status = STATUS[tool.status]
  return (
    <article className="chat__call">
      <div className="chat__tool-head">
        <Text scale="label-large" tone="variant">
          {KIND[tool.itemType]}
        </Text>
        <State size="small" state={status.state}>
          {status.word}
        </State>
      </div>
      {tool.title ? <Mono className="chat__tool-title chat__code">{tool.title}</Mono> : null}
      {tool.output ? (
        <details className="chat__tool-output">
          <summary>Output</summary>
          <pre>{tool.output}</pre>
        </details>
      ) : null}
    </article>
  )
}

type Work = Extract<Row, { kind: 'work' }>

/** A turn's calls in one row. It is open while the turn runs and shut once it ends, until the person chooses. */
export function WorkLog(props: { work: Work; said: (message: Message) => ReactNode }) {
  const { work, said } = props
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? work.state === 'running'
  const body = useId()
  return (
    <section className="chat__tool chat__work" data-state={work.state}>
      <button
        aria-controls={body}
        aria-expanded={open}
        className="chat__work-toggle"
        onClick={() => setChosen(!open)}
        type="button"
      >
        <span className="chat__work-label">{work.label}</span>
        {work.calls > 0 ? <span className="chat__work-count">{work.calls === 1 ? '1 call' : `${work.calls} calls`}</span> : null}
        <State size="small" state={work.state} />
        <ChevronDown aria-hidden="true" className="chat__work-chevron" size={20} />
      </button>
      <div className="chat__work-body" hidden={!open} id={body}>
        {work.items.map((item) =>
          item.kind === 'tool' ? <Call key={item.id} tool={item} /> : <div key={item.id}>{said(item)}</div>,
        )}
      </div>
    </section>
  )
}
