import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Disclosure } from './Disclosure'

describe('Disclosure', () => {
  it('opens and closes from its trigger, which is named by the summary too', () => {
    render(
      <Disclosure summary="8 workspaces, nothing running">
        <ul>
          <li>price-table</li>
        </ul>
      </Disclosure>,
    )
    const trigger = screen.getByRole('button', { name: 'Show 8 workspaces, nothing running' })
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
    expect(screen.getByRole('button', { name: 'Hide Idle' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('rows')).toBeTruthy()
  })

  it('names its panel with aria-controls', () => {
    render(
      <Disclosure summary="Idle" defaultOpen>
        rows
      </Disclosure>,
    )
    const trigger = screen.getByRole('button', { name: 'Show Idle' })
    const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('rows')
  })

  it('makes the panel inert while closed', () => {
    render(<Disclosure summary="Idle">rows</Disclosure>)
    const trigger = screen.getByRole('button', { name: 'Show Idle' })
    const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    expect(panel?.hasAttribute('inert')).toBe(true)
    fireEvent.click(trigger)
    expect(panel?.hasAttribute('inert')).toBe(false)
    fireEvent.click(trigger)
    expect(panel?.hasAttribute('inert')).toBe(true)
  })

  it('keeps content mounted after the first open, so the close can animate', () => {
    render(<Disclosure summary="Idle">rows</Disclosure>)
    const trigger = screen.getByRole('button', { name: 'Show Idle' })
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(screen.getByText('rows')).toBeTruthy()
  })
})
