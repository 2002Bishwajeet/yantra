import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Interaction } from '@/api/thread'
import { PlanToggle } from './PlanToggle'

describe('PlanToggle', () => {
  it('names the interaction, says whether Plan is pressed, and toggles both ways', () => {
    const onChange = vi.fn<(interaction: Interaction) => void>()
    const { rerender } = render(<PlanToggle onChange={onChange} value="build" />)
    const build = screen.getByRole('button', { name: 'Build' })
    expect(build.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(build)
    expect(onChange).toHaveBeenLastCalledWith('plan')

    rerender(<PlanToggle onChange={onChange} value="plan" />)
    const plan = screen.getByRole('button', { name: 'Plan' })
    expect(plan.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(plan)
    expect(onChange).toHaveBeenLastCalledWith('build')
  })

  it('draws a glyph of its own for each, since a phone shows no words', () => {
    const glyph = (value: Interaction) => {
      const { unmount } = render(<PlanToggle onChange={() => {}} value={value} />)
      const svg = screen.getByRole('button').querySelector('svg')!
      unmount()
      return svg.getAttribute('class')
    }
    expect(glyph('build')).not.toBe(glyph('plan'))
  })

  it('cannot be pressed when disabled, and says why', () => {
    const onChange = vi.fn<(interaction: Interaction) => void>()
    render(<PlanToggle disabled="Plan mode needs Claude" onChange={onChange} value="build" />)
    const button = screen.getByRole('button', { name: 'Build' })
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toBe('Plan mode needs Claude')
    fireEvent.click(button)
    expect(onChange).not.toHaveBeenCalled()
  })
})
