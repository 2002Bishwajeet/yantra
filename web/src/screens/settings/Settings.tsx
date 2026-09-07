import { Link, useParams } from '@tanstack/react-router'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { List, ListChevron, ListItem } from '@/m3/list/List'
import { Eyebrow, Text } from '@/m3/text/Text'
import { useFormFactor } from '@/shell/formFactor'
import { Nowhere } from '@/shell/Shell'
import { CATEGORIES, categoryOf, type Category, GROUPS } from './categories'
import './Settings.css'

/** `/settings` and `/settings/$category` (Y-350). Not a dashboard: a category
 *  list and one category of grouped rows (BRIEF.md, Settings register). A
 *  desktop and a tablet draw both panes; a phone draws the list as an index
 *  and pushes one category. */
export function Settings() {
  const { category: id } = useParams({ strict: false })
  const factor = useFormFactor()
  const chosen = categoryOf(id)
  if (id !== undefined && chosen === undefined) return <Nowhere />

  if (factor === 'phone') {
    return chosen ? <Pane category={chosen} level={1} /> : <Index />
  }

  return (
    <div className="settings" data-factor={factor}>
      <nav aria-label="Settings" className="settings__nav">
        <h1 className="settings__title">Settings</h1>
        {GROUPS.map((group) => (
          <div className="settings__catgroup" key={group}>
            <Eyebrow className="settings__eyebrow" id={`settings-${group}`}>
              {group}
            </Eyebrow>
            <ul aria-labelledby={`settings-${group}`} className="settings__cats">
              {CATEGORIES.filter((one) => one.group === group).map((one) => (
                <li key={one.id}>
                  <Link
                    aria-current={one.id === (chosen ?? CATEGORIES[0]).id ? 'page' : undefined}
                    className="settings__cat m3-interactive"
                    params={{ category: one.id }}
                    to="/settings/$category"
                  >
                    <span aria-hidden="true" className="settings__cat-icon">
                      {one.icon}
                    </span>
                    {one.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <Pane category={chosen ?? CATEGORIES[0]} level={2} />
    </div>
  )
}

/** The phone's index: every category as a row that pushes its screen. */
function Index() {
  return (
    <>
      <h1>Settings</h1>
      {GROUPS.map((group) => (
        <section aria-label={group} className="settings__group" key={group}>
          <Eyebrow as="h2" className="settings__eyebrow">
            {group}
          </Eyebrow>
          <List>
            {CATEGORIES.filter((one) => one.group === group).map((one) => (
              <ListItem
                headline={one.label}
                key={one.id}
                leading={
                  <span aria-hidden="true" className="settings__cat-icon">
                    {one.icon}
                  </span>
                }
                render={<Link params={{ category: one.id }} to="/settings/$category" />}
                trailing={<ListChevron />}
              />
            ))}
          </List>
        </section>
      ))}
    </>
  )
}

/** One category. `level` 1 is the phone, where the title is the app bar's
 *  and the shell hides the h1; 2 sits under the desktop's "Settings". */
function Pane(props: { category: Category; level: 1 | 2 }) {
  const { category, level } = props
  const { Screen, label, blurb } = category
  return (
    <section aria-labelledby="settings-category" className="settings__pane" key={category.id}>
      <header className="settings__head">
        <Text as={level === 1 ? 'h1' : 'h2'} id="settings-category" scale="headline-small" emphasized>
          {label}
        </Text>
        <Text as="p" scale="body-medium" tone="variant">
          {blurb}
        </Text>
      </header>
      <ErrorBoundary layout="card" resetKeys={[category.id]} title={`${label} could not be drawn`}>
        <Screen />
      </ErrorBoundary>
    </section>
  )
}
