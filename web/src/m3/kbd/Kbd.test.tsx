import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Kbd } from './Kbd'

afterEach(cleanup)

describe('Kbd', () => {
  it('is a kbd element in mono', () => {
    render(<Kbd>⌘K</Kbd>)
    const kbd = screen.getByText('⌘K')
    expect(kbd.tagName).toBe('KBD')
    expect(kbd.className).toContain('m3-mono')
  })
})
