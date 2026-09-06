import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Plus } from 'lucide-react'
import { ExtendedFab, Fab } from './Fab'

afterEach(cleanup)

describe('Fab', () => {
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
})
