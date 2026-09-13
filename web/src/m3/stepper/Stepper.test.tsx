import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Stepper } from './Stepper'

const steps = ['Name', 'Machine', 'Source', 'Start'] as const

describe('Stepper', () => {
  it('is a list with one current step and the done ones said', () => {
    render(<Stepper steps={steps} current={2} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(4)
    expect(items[2].getAttribute('aria-current')).toBe('step')
    expect(items[0].dataset.state).toBe('done')
    expect(items[0].textContent).toContain('done')
    expect(items[3].dataset.state).toBe('ahead')
    expect(items[3].textContent).toBe('4Start')
  })
})

describe('Stepper, vertical', () => {
  it('says each state, and folds a done step to its title and line', () => {
    render(
      <Stepper
        items={[
          { title: 'On the tailnet', state: 'done', words: 'pi is on the tailnet', body: 'install Tailscale' },
          { title: 'Joined', state: 'stuck', words: 'ssh logs in as another account', body: 'the join command' },
          { title: 'Reachable', state: 'current', words: 'checking', body: 'Check again' },
          { title: 'Ready', state: 'ahead' },
        ]}
        orientation="vertical"
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(screen.getByRole('list').dataset.orientation).toBe('vertical')
    expect(items[0].textContent).toBe('On the tailnet, donepi is on the tailnet')
    expect(items[1].textContent).toContain('Joined, stuck')
    expect(items[1].textContent).toContain('the join command')
    expect(items[2].getAttribute('aria-current')).toBe('step')
    expect(items[2].textContent).toContain('Check again')
    expect(items[3].textContent).toBe('4Ready')
  })
})
