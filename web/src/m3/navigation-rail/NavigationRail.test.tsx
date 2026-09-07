import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { LayoutDashboard, Layers, Plus } from 'lucide-react'
import { renderRouted } from '@/test/inRouter'
import { Fab } from '../fab/Fab'
import { NavigationRail, RailDestination } from './NavigationRail'

describe('NavigationRail', () => {
  it('is the main navigation with its FAB and destinations', () => {
    render(
      <NavigationRail
        fab={
          <Fab label="New session">
            <Plus />
          </Fab>
        }
      >
        <RailDestination icon={<LayoutDashboard />} active>
          Dashboard
        </RailDestination>
        <RailDestination icon={<Layers />}>Fleet</RailDestination>
      </NavigationRail>,
    )
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Fleet' }).hasAttribute('aria-current')).toBe(false)
  })

  it('lets the router mark the current link, and warns of nothing', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderRouted(
      <NavigationRail>
        <RailDestination icon={<LayoutDashboard />} render={<Link to="/" />}>
          Dashboard
        </RailDestination>
      </NavigationRail>,
    )
    const link = screen.getByRole('link', { name: 'Dashboard' })
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(link.hasAttribute('type')).toBe(false)
    expect(complained).not.toHaveBeenCalled()
    complained.mockRestore()
  })
})
