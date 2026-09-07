import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Stepper } from './Stepper'

afterEach(cleanup)

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
