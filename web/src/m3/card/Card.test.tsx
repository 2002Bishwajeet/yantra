import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Card } from './Card'

describe('Card', () => {
  it('is a filled section on the container tier by default', () => {
    render(<Card aria-label="Running">rows</Card>)
    const card = screen.getByRole('region', { name: 'Running' })
    expect(card.tagName).toBe('SECTION')
    expect(card.dataset.variant).toBe('filled')
    expect(card.dataset.surface).toBe('container')
  })

  it.each(['elevated', 'outlined'] as const)('draws %s', (variant) => {
    render(<Card variant={variant} as="article" data-testid="c" />)
    expect(screen.getByTestId('c').dataset.variant).toBe(variant)
    expect(screen.getByTestId('c').tagName).toBe('ARTICLE')
  })

  it('tints the hero', () => {
    render(<Card surface="primary" data-testid="c" />)
    expect(screen.getByTestId('c').dataset.surface).toBe('primary')
  })
})
