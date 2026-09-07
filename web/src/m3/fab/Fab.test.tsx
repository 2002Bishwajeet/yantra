import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Plus } from 'lucide-react'
import { ExtendedFab, Fab } from './Fab'

describe('Fab', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is named by its label and sized by a word', () => {
    render(
      <Fab label="New session" size="medium">
        <Plus />
      </Fab>,
    )
    const fab = screen.getByRole('button', { name: 'New session' })
    expect(fab.dataset.size).toBe('medium')
    expect(fab.querySelector('svg')?.closest('[aria-hidden="true"]')).toBeTruthy()
  })

  it('extends with a visible label', () => {
    render(<ExtendedFab icon={<Plus />}>New session</ExtendedFab>)
    const fab = screen.getByRole('button', { name: 'New session' })
    expect(fab.dataset.size).toBe('extended')
  })

  it('is a link without a Base UI warning when rendered as one', () => {
    const warned = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <Fab label="New session" render={<a href="/new" />} role="link">
        <Plus />
      </Fab>,
    )
    const fab = screen.getByRole('link', { name: 'New session' })
    expect(fab.tagName).toBe('A')
    expect(warned).not.toHaveBeenCalled()
  })
})
