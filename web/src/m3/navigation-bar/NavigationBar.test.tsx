import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { BarChart3, Cpu, LayoutDashboard, Layers } from 'lucide-react'
import { renderRouted } from '@/test/inRouter'
import { BarDestination, NavigationBar } from './NavigationBar'

describe('NavigationBar', () => {
  it('holds four named links, the router marking the current one', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderRouted(
      <NavigationBar>
        <BarDestination icon={<LayoutDashboard />} render={<Link to="/" />}>Dashboard</BarDestination>
        <BarDestination icon={<Layers />} render={<Link to="/fleet" />}>Fleet</BarDestination>
        <BarDestination icon={<Cpu />} render={<Link to="/machines" />}>Machines</BarDestination>
        <BarDestination icon={<BarChart3 />} render={<Link to="/usage" />}>Usage</BarDestination>
      </NavigationBar>,
    )
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    const links = screen.getAllByRole('link')
    expect(links.map((one) => one.getAttribute('href'))).toEqual(['/', '/fleet', '/machines', '/usage'])
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Fleet' }).hasAttribute('aria-current')).toBe(false)
    expect(complained).not.toHaveBeenCalled()
    complained.mockRestore()
  })

  it('takes `active` for a destination that is not a link', () => {
    render(
      <NavigationBar>
        <BarDestination icon={<LayoutDashboard />} active>Dashboard</BarDestination>
        <BarDestination icon={<Layers />}>Fleet</BarDestination>
      </NavigationBar>,
    )
    expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page')
  })
})
