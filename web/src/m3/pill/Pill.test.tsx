import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { renderRouted } from '@/test/inRouter'
import { Pill, PillGroup } from './Pill'

describe('Pill', () => {
  it('says whether it is pressed when it is a button with a selection', () => {
    const onClick = vi.fn()
    render(
      <PillGroup>
        <Pill selected>Dashboard</Pill>
        <Pill selected={false} onClick={onClick}>Fleet</Pill>
      </PillGroup>,
    )
    expect(screen.getByRole('button', { name: 'Dashboard', pressed: true })).toBeTruthy()
    const fleet = screen.getByRole('button', { name: 'Fleet', pressed: false })
    fireEvent.click(fleet)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('is a plain button, not an unpressed toggle, without a selection', () => {
    render(<Pill>Search anything</Pill>)
    expect(screen.getByRole('button', { name: 'Search anything' }).hasAttribute('aria-pressed')).toBe(false)
  })

  it('leaves aria-current to the router when it is a link, and warns of nothing', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderRouted(
      <PillGroup>
        <Pill render={<Link to="/" />}>Dashboard</Pill>
      </PillGroup>,
    )
    const link = screen.getByRole('link', { name: 'Dashboard' })
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(link.hasAttribute('aria-pressed')).toBe(false)
    expect(link.hasAttribute('type')).toBe(false)
    expect(complained).not.toHaveBeenCalled()
    complained.mockRestore()
  })
})
