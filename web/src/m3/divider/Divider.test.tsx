import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Divider } from './Divider'

describe('Divider', () => {
  it('is a separator, horizontal unless told otherwise', () => {
    render(<Divider />)
    expect(screen.getByRole('separator').dataset.orientation).toBe('horizontal')
    cleanup()
    render(<Divider orientation="vertical" />)
    expect(screen.getByRole('separator').dataset.orientation).toBe('vertical')
  })
})
