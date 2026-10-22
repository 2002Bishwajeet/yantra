import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Plan } from '@/screens/session/timeline'
import { PlanBadge } from './PlanBadge'

afterEach(cleanup)

const plan: Plan = [
  { step: 'Read the tests', status: 'completed' },
  { step: 'Fix the parser', status: 'inProgress' },
  { step: 'Run the suite', status: 'pending' },
]

describe('the plan badge', () => {
  it('names the step the agent is on and how many are done', () => {
    render(<PlanBadge plan={plan} />)
    const row = screen.getByRole('button', { name: 'Plan: 1 of 3 complete. Current step: Fix the parser' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.textContent).toContain('1/3')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists every step with its status, and folds again', () => {
    render(<PlanBadge plan={plan} />)
    fireEvent.click(screen.getByRole('button', { name: /^Plan:/ }))
    const steps = within(screen.getByRole('list', { name: 'Plan. 1 of 3 complete.' })).getAllByRole('listitem')
    expect(steps.map((one) => one.textContent)).toEqual([
      'Completed: Read the tests',
      'Running: Fix the parser',
      'Pending: Run the suite',
    ])
    fireEvent.click(screen.getByRole('button', { name: /^Collapse plan:/ }))
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows the last step when all are done', () => {
    render(<PlanBadge plan={plan.map((one) => ({ ...one, status: 'completed' as const }))} />)
    expect(screen.getByRole('button', { name: 'Plan: 3 of 3 complete. Current step: Run the suite' })).toBeTruthy()
  })

  it('draws nothing for an empty plan', () => {
    const { container } = render(<PlanBadge plan={[]} />)
    expect(container.innerHTML).toBe('')
  })
})
