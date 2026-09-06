import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { LayoutDashboard, Layers, Plus } from 'lucide-react'
import { renderRouted } from '@/test/inRouter'
import { Fab } from '../fab/Fab'
import { NavigationRail, RailDestination } from './NavigationRail'

afterEach(cleanup)

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

  it('lets the router mark the current link', async () => {
    await renderRouted(
      <NavigationRail>
        <RailDestination icon={<LayoutDashboard />} render={<Link to="/" />}>
          Dashboard
        </RailDestination>
      </NavigationRail>,
    )
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page')
  })
})
