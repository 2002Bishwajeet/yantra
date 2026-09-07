import type { ComponentType, ReactNode } from 'react'
import { Bell, Bot, Info, KeyRound, Palette, Plug, SlidersHorizontal } from 'lucide-react'
import { About } from './About'
import { Access } from './Access'
import { Agents } from './Agents'
import { Appearance } from './Appearance'
import { General } from './General'
import { Notifications } from './Notifications'
import { Providers } from './Providers'

export type Category = {
  id: string
  label: string
  /** Workspace is what the dashboard does; Appliance is the daemon itself. */
  group: 'Workspace' | 'Appliance'
  icon: ReactNode
  blurb: string
  Screen: ComponentType
}

/** The register's seven categories, in the boards' order. */
export const CATEGORIES: readonly Category[] = [
  {
    id: 'general',
    label: 'General',
    group: 'Workspace',
    icon: <SlidersHorizontal />,
    blurb: 'Where clones land and what a new session assumes before you change anything.',
    Screen: General,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    group: 'Workspace',
    icon: <Bell />,
    blurb: 'What reaches your phone when the dashboard is not open.',
    Screen: Notifications,
  },
  {
    id: 'providers',
    label: 'Providers',
    group: 'Workspace',
    icon: <Plug />,
    blurb: 'Where repositories and models come from. Yantra signs in to GitHub itself; agents use the sign-ins on each machine.',
    Screen: Providers,
  },
  {
    id: 'agents',
    label: 'Agents',
    group: 'Workspace',
    icon: <Bot />,
    blurb: 'What a session can start.',
    Screen: Agents,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'Workspace',
    icon: <Palette />,
    blurb: 'how the dashboard looks on this device',
    Screen: Appearance,
  },
  {
    id: 'access',
    label: 'Access',
    group: 'Appliance',
    icon: <KeyRound />,
    blurb: 'The key the daemon holds, and who can reach the dashboard. There is no login.',
    Screen: Access,
  },
  {
    id: 'about',
    label: 'About',
    group: 'Appliance',
    icon: <Info />,
    blurb: 'The daemon on the appliance, and where its pieces live.',
    Screen: About,
  },
]

export const GROUPS = ['Workspace', 'Appliance'] as const

export const categoryOf = (id: string | undefined) => CATEGORIES.find((one) => one.id === id)
