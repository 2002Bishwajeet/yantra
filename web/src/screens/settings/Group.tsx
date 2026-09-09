import type { ReactNode } from 'react'
import { List } from '@/m3/list/List'
import { Eyebrow, Text } from '@/m3/text/Text'

/** One labelled group of rows, the unit every category is built from
 *  (BRIEF.md, Settings register): an eyebrow, a List, an optional line under
 *  it. `children` are ListItems; `note` is the group's own footnote. */
export function Group(props: { label: string; note?: ReactNode; children: ReactNode }) {
  const { label, note, children } = props
  return (
    <section className="settings__group" aria-label={label}>
      <Eyebrow render={<h3 />} className="settings__eyebrow">
        {label}
      </Eyebrow>
      <List>{children}</List>
      {note ? <Note>{note}</Note> : null}
    </section>
  )
}

/** A footnote under a group or a category. */
export function Note(props: { children: ReactNode }) {
  return (
    <Text render={<p />} className="settings__note" scale="body-small" tone="variant">
      {props.children}
    </Text>
  )
}
