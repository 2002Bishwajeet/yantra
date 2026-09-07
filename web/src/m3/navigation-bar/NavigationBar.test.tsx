import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { BarChart3, Cpu, LayoutDashboard, Layers } from 'lucide-react'
import { BarDestination, NavigationBar } from './NavigationBar'

afterEach(cleanup)

describe('NavigationBar', () => {
  it('holds four named destinations with one current', () => {
    render(
      <NavigationBar>
        <BarDestination icon={<LayoutDashboard />} active>Dashboard</BarDestination>
        <BarDestination icon={<Layers />}>Fleet</BarDestination>
        <BarDestination icon={<Cpu />}>Machines</BarDestination>
        <BarDestination icon={<BarChart3 />}>Usage</BarDestination>
      </NavigationBar>,
    )
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page')
  })
})
