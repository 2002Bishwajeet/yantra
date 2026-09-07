import type { ReactNode } from 'react'
import { Tabs } from '@base-ui/react/tabs'
import { clsx } from 'clsx'
import './TabPills.css'

export type TabPillsProps = Tabs.List.Props & {
  /** The tablist's accessible name: "Session views". */
  label: string
  children: ReactNode
}

/** In-page tabs drawn as the boards' pill group; the selected pill slides on a
 *  spring. The list only: TabsRoot holds the value, so the panels beside it
 *  read the same one. For navigation between routes use Pill with a Link. */
export function TabPills(props: TabPillsProps) {
  const { label, className, children, ...rest } = props
  return (
    <Tabs.List className={clsx('m3-tab-pills', 'm3-tab-pills__list', className)} aria-label={label} {...rest}>
      <Tabs.Indicator className="m3-tab-pills__indicator" renderBeforeHydration />
      {children}
    </Tabs.List>
  )
}

export type TabPillProps = Tabs.Tab.Props & { children: ReactNode }

export function TabPill(props: TabPillProps) {
  const { className, ...rest } = props
  return <Tabs.Tab className={clsx('m3-tab-pill', 'm3-interactive', className)} {...rest} />
}

export type TabPanelProps = Tabs.Panel.Props & { children: ReactNode }

/** Render each panel as a sibling of TabPills, inside the same Tabs.Root. */
export function TabPanel(props: TabPanelProps) {
  const { className, ...rest } = props
  return <Tabs.Panel className={clsx('m3-tab-panel', className)} {...rest} />
}

export const TabsRoot = Tabs.Root
