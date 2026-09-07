import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Disclosure } from './Disclosure'

afterEach(cleanup)

describe('Disclosure', () => {
  it('opens and closes from its trigger, and says so', () => {
    render(
      <Disclosure summary="8 workspaces, nothing running">
        <ul>
          <li>price-table</li>
        </ul>
      </Disclosure>,
    )
    const trigger = screen.getByRole('button', { name: 'Show' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('price-table')).toBeNull()
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('price-table')).toBeTruthy()
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('starts open when asked', () => {
    render(
      <Disclosure summary="Idle" action="Hide" defaultOpen>
        rows
      </Disclosure>,
    )
    expect(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('rows')).toBeTruthy()
  })
})
