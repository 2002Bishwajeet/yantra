import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { renderRouted } from '@/test/inRouter'
import { Pill, PillGroup } from './Pill'

afterEach(cleanup)

describe('Pill', () => {
  it('says whether it is pressed when it is a button', () => {
    const onClick = vi.fn()
    render(
      <PillGroup>
        <Pill selected>Dashboard</Pill>
        <Pill onClick={onClick}>Fleet</Pill>
      </PillGroup>,
    )
    expect(screen.getByRole('button', { name: 'Dashboard', pressed: true })).toBeTruthy()
    const fleet = screen.getByRole('button', { name: 'Fleet', pressed: false })
    fireEvent.click(fleet)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('leaves aria-current to the router when it is a link', async () => {
    await renderRouted(
      <PillGroup>
        <Pill render={<Link to="/" />}>Dashboard</Pill>
      </PillGroup>,
    )
    const link = screen.getByRole('link', { name: 'Dashboard' })
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(link.hasAttribute('aria-pressed')).toBe(false)
  })
})
