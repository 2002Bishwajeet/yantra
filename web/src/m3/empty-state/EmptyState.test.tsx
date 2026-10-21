import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('says the answer, and why it is one', () => {
    render(<EmptyState title="Nothing needs you">when an agent asks, it appears here first</EmptyState>)
    expect(screen.getByText('Nothing needs you')).toBeTruthy()
    expect(screen.getByText('when an agent asks, it appears here first')).toBeTruthy()
  })

  it('draws no line of reason when it has none', () => {
    const { container } = render(<EmptyState title="Nothing unread" />)
    expect(container.querySelector('p')).toBeNull()
  })

  it('draws the way out under the reason', () => {
    render(
      <EmptyState action={<button type="button">Resume</button>} state="needs" title="Paused">
        The agents sent 20 messages.
      </EmptyState>,
    )
    expect(screen.getByRole('button', { name: 'Resume' }).closest('.m3-empty__action')).toBeTruthy()
  })

  it('is a block other surfaces find by its slot', () => {
    const { container } = render(<EmptyState title="No rooms" />)
    expect(container.querySelector('[data-slot="empty"]')).toBeTruthy()
  })

  it('has a compact banner that is a start-aligned row with the action at the far end', () => {
    const { container } = render(
      <EmptyState action={<button type="button">Resume</button>} compact title="Paused">
        The agents sent 20 messages.
      </EmptyState>,
    )
    expect(container.querySelector('[data-slot="empty"]')?.hasAttribute('data-compact')).toBe(true)
    const css = readFileSync(resolve(process.cwd(), 'src/m3/empty-state/EmptyState.css'), 'utf8')
    expect(css).toMatch(/\.m3-empty\[data-compact\] \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;[^}]*text-align: start;/s)
  })
})
