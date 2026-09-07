import { useEffect, useId, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Cpu, FileText, Search } from 'lucide-react'
import { loaded, useAgents, useMachines, useWorkspaces, type Reading } from '@/api/hooks'
import { Dialog, DialogPopup } from '@/m3/dialog/Dialog'
import { Kbd } from '@/m3/kbd/Kbd'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Row, RowText } from '@/m3/row/Row'
import { Eyebrow } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { IconTile, Tile } from '@/m3/tile/Tile'
import { phrase } from './phrase'
import './Palette.css'

/** D3 §3.2: every entry is a place. No entry is a verb, which is what keeps a
 *  destructive action further than two keystrokes from anywhere. */
type Entry = {
  key: string
  label: string
  supporting?: string
  mark?: MarkState
  go: () => void
}

type Group = { label: string; entries: Entry[] }

const PAGES = [
  { to: '/', label: 'Dashboard' },
  { to: '/fleet', label: 'Fleet' },
  { to: '/machines', label: 'Machines' },
  { to: '/usage', label: 'Usage' },
  { to: '/new', label: 'New session' },
  { to: '/settings', label: 'Settings' },
] as const

/** R-23: a class nobody could read is not a class with nothing in it, so the
 *  palette names it rather than offering an empty group under its heading. */
function unread(name: string, query: Reading<unknown>): string | null {
  if (query.looked === 'ok') return null
  return query.looked === 'never' ? `${name} have not been read yet.` : `${name} could not be read.`
}

function Highlight(props: { text: string; query: string }) {
  const { text, query } = props
  const start = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (start < 0) return text
  return (
    <>
      {text.slice(0, start)}
      <mark className="palette__match">{text.slice(start, start + query.length)}</mark>
      {text.slice(start + query.length)}
    </>
  )
}

export function PalettePopup(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { open, onOpenChange } = props
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const workspaces = loaded(useWorkspaces())
  const agents = useAgents(workspaces)
  const machines = useMachines()

  const go = (to: () => void) => {
    onOpenChange(false)
    setQuery('')
    setActive(0)
    to()
  }

  const groups: Group[] = [
    {
      label: 'Workspaces',
      entries:
        agents.looked === 'ok'
          ? agents.data.map((row) => ({
              key: `w:${row.workspace.name}`,
              label: row.workspace.name,
              supporting: `${phrase(row.status).words} · ${row.workspace.machine}`,
              mark: phrase(row.status).mark,
              go: () =>
                void navigate({
                  to: '/w/$name',
                  params: { name: row.workspace.name },
                  search: { view: 'chat' },
                }),
            }))
          : [],
    },
    {
      label: 'Machines',
      entries:
        machines.looked === 'ok'
          ? machines.data.map((one) => ({
              key: `m:${one.name}`,
              label: one.name,
              supporting: one.online ? `online · ${one.os}` : `offline · ${one.os}`,
              go: () => void navigate({ to: '/m/$machine', params: { machine: one.name } }),
            }))
          : [],
    },
    {
      label: 'Pages',
      entries: PAGES.map((page) => ({
        key: `p:${page.to}`,
        label: page.label,
        go: () => void navigate({ to: page.to }),
      })),
    },
  ]
    .map((group) => ({
      ...group,
      entries: group.entries.filter((one) => one.label.toLowerCase().includes(query.toLowerCase())),
    }))
    .filter((group) => group.entries.length > 0)

  const flat = groups.flatMap((group) => group.entries)
  const current = Math.min(active, Math.max(flat.length - 1, 0))
  const notes = [unread('Workspaces', workspaces), unread('Machines', machines)].filter(
    (one) => one !== null,
  )

  // 2.4.7: the list is 50vh and scrolls, so the arrow keys have to bring the
  // option they moved to with them. Optional because jsdom has no such method.
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [listId, current])

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="palette" title="Search">
        <TextField
          aria-activedescendant={flat.length ? `${listId}-${current}` : undefined}
          aria-controls={listId}
          aria-expanded="true"
          autoFocus
          label="Search anything"
          leading={<Search />}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((was) => Math.min(was + 1, flat.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((was) => Math.max(was - 1, 0))
            } else if (event.key === 'Enter' && flat[current]) {
              event.preventDefault()
              go(flat[current].go)
            }
          }}
          onValueChange={(value) => {
            setQuery(String(value))
            setActive(0)
          }}
          role="combobox"
          trailing={<Kbd>Esc</Kbd>}
          value={query}
        />
        <div className="palette__list" id={listId} role="listbox" aria-label="Places">
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <Eyebrow className="palette__label">{group.label}</Eyebrow>
              {group.entries.map((entry) => {
                const index = flat.indexOf(entry)
                return (
                  <Row
                    aria-selected={index === current}
                    className="palette__row"
                    id={`${listId}-${index}`}
                    key={entry.key}
                    onClick={() => go(entry.go)}
                    onMouseEnter={() => setActive(index)}
                    render={<button type="button" role="option" />}
                    tone={index === current ? 'selected' : 'plain'}
                  >
                    {entry.key.startsWith('w:') ? (
                      <Tile name={entry.label} />
                    ) : (
                      <IconTile>{entry.key.startsWith('m:') ? <Cpu /> : <FileText />}</IconTile>
                    )}
                    <RowText
                      headline={<Highlight query={query} text={entry.label} />}
                      supporting={
                        entry.supporting ? (
                          entry.mark ? (
                            <State size="small" state={entry.mark}>
                              {entry.supporting}
                            </State>
                          ) : (
                            entry.supporting
                          )
                        ) : undefined
                      }
                    />
                    {index === current ? <Kbd aria-hidden="true">Enter</Kbd> : null}
                  </Row>
                )
              })}
            </div>
          ))}
          {flat.length === 0 ? <p className="palette__empty">Nothing matches.</p> : null}
        </div>
        <div className="palette__foot">
          <span>
            {notes.length ? notes.join(' ') : 'Finds a workspace, a machine or a page. Never runs a verb.'}
          </span>
          <span className="palette__legend" aria-hidden="true">
            <Kbd>↑↓</Kbd> move <Kbd>Enter</Kbd> open <Kbd>Esc</Kbd> close
          </span>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
