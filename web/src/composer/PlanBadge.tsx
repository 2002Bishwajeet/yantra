/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ComposerTasksBadge.tsx:
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ComposerTasksBadge.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId, useState } from 'react'
import { Check, ChevronDown, CircleDot, Circle, ListTodo } from 'lucide-react'
import type { Plan } from '@/screens/session/timeline'

const MAX_SEGMENTS = 10

const WORD = { pending: 'Pending', inProgress: 'Running', completed: 'Completed' } as const
const GLYPH = { pending: Circle, inProgress: CircleDot, completed: Check } as const

/** Where the agent is in its plan: the step it is on, and how many are done. */
function progress(plan: Plan) {
  const done = plan.filter((one) => one.status === 'completed').length
  const current = plan.find((one) => one.status === 'inProgress') ?? plan.find((one) => one.status === 'pending') ?? plan.at(-1)
  return { done, total: plan.length, step: current?.step ?? '' }
}

/** A tab on the card's top edge. It draws nothing for an empty plan. */
export function PlanBadge(props: { plan: Plan }) {
  const { plan } = props
  const [open, setOpen] = useState(false)
  const list = useId()
  if (plan.length === 0) return null
  const { done, total, step } = progress(plan)
  return (
    <div className="composer__plan">
      <button
        aria-controls={open ? list : undefined}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse plan' : 'Plan'}: ${done} of ${total} complete. Current step: ${step}`}
        className="composer-plan__row m3-interactive"
        onClick={() => setOpen((now) => !now)}
        type="button"
      >
        <ListTodo aria-hidden="true" />
        <span className="composer-plan__label">Plan</span>
        <span className="composer-plan__current">{step}</span>
        <span className="composer-plan__count" data-done={done >= total ? '' : undefined}>
          {done}/{total}
        </span>
        {total > 1 && total <= MAX_SEGMENTS ? (
          <span aria-hidden="true" className="composer-plan__segments">
            {plan.map((one, at) => (
              <span data-status={one.status} key={at} />
            ))}
          </span>
        ) : null}
        <ChevronDown aria-hidden="true" className="composer-plan__chevron" />
      </button>
      {open ? (
        <ul aria-label={`Plan. ${done} of ${total} complete.`} className="composer-plan__steps" id={list}>
          {plan.map((one, at) => {
            const Glyph = GLYPH[one.status]
            return (
              <li data-status={one.status} key={at}>
                <Glyph aria-hidden="true" />
                <span>
                  <span className="m3-sr-only">{WORD[one.status]}: </span>
                  {one.step}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
