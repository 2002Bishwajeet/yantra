import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Cpu, FileText, Play, Search } from 'lucide-react'
import type { Item } from '@/api'
import { loaded, useAgents, useAttention, useMachines, useWorkspaces, type Reading } from '@/api/hooks'
import { Dialog, DialogPopup } from '@/m3/dialog/Dialog'
import { Kbd } from '@/m3/kbd/Kbd'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Row, RowText } from '@/m3/row/Row'
import { Eyebrow } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { IconTile, Tile } from '@/m3/tile/Tile'
import { StartSession } from '@/screens/fleet/StartSession'
import { keyOf, type LoopId } from '@/screens/session/keys'
import { KeyboardHelp } from './KeyboardHelp'
import { useLoopCommands } from './loopCommands'
import { phrase } from './phrase'
import './Palette.css'

/** D3 §3.2, amended for M16 (Y-499): an entry is a place, or one of the coding loop's verbs.
 *  A verb opens the dialog that asks, so Merge stays two steps from the palette. */
type Entry = {
  key: string
  label: string
  supporting?: string
  mark?: MarkState
  /** The chord that runs the same entry. */
  chord?: string
  /** Why a verb does nothing now. */
  off?: string
  /** Opens a dialog, so it waits for the palette to close. */
  verb?: boolean
  /** Searched with the label. */
  terms?: string
  go: () => void
}

type Group = { label: string; entries: Entry[] }

const NO_ISSUE = 'No issue is assigned to you.'

const PAGES = [
  { to: '/', label: 'Dashboard' },
  { to: '/fleet', label: 'Fleet' },
  { to: '/machines', label: 'Machines' },
  { to: '/usage', label: 'Usage' },
  { to: '/new', label: 'New session' },
  { to: '/rooms', label: 'Rooms' },
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

export function PalettePopup(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  help: boolean
  onHelpChange: (open: boolean) => void
  /** A query to put in the field, such as the issue chord's. */
  seed: { query: string } | null
}) {
  const { open, onOpenChange, help, onHelpChange, seed } = props
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const legendId = useId()
  const workspaces = loaded(useWorkspaces())
  const agents = useAgents(workspaces)
  const machines = useMachines()
  const attention = useAttention()
  const loop = useLoopCommands()
  const [starting, setStarting] = useState<Item | null>(null)
  // A verb waits for the palette to finish closing, so its dialog is not opened under the focus the palette hands back.
  const after = useRef<(() => void) | null>(null)

  const [seeded, setSeeded] = useState<typeof seed>(null)
  if (seed !== seeded) {
    setSeeded(seed)
    if (seed) {
      setQuery(seed.query)
      setActive(0)
    }
  }

  const go = (to: () => void, verb = false) => {
    onOpenChange(false)
    setQuery('')
    setActive(0)
    if (verb) after.current = to
    else to()
  }

  const issues = attention.looked === 'ok' ? attention.data.issues : []
  const startKey = keyOf('issue')
  const commands: Entry[] = [
    ...(issues.length
      ? issues.map((issue, index) => {
          const named = `${issue.repo}#${issue.number} ${issue.title}`
          return {
            key: `c:issue:${issue.repo}#${issue.number}`,
            label: startKey.label,
            supporting: named,
            terms: named,
            chord: index === 0 ? startKey.display : undefined,
            verb: true,
            go: () => setStarting(issue),
          }
        })
      : [
          {
            key: 'c:issue',
            label: startKey.label,
            supporting: NO_ISSUE,
            off: NO_ISSUE,
            chord: startKey.display,
            verb: true,
            go: () => {},
          },
        ]),
    ...(['diff', 'commit', 'push', 'pr', 'merge'] as const satisfies readonly LoopId[]).flatMap((id) => {
      const command = loop.find((one) => one.id === id)
      if (!command) return []
      const key = keyOf(id)
      return [
        {
          key: `c:${id}`,
          label: key.label,
          supporting: command.reason ?? undefined,
          off: command.reason ?? undefined,
          chord: key.display,
          verb: true,
          go: command.run,
        },
      ]
    }),
  ]

  const all: Group[] = [
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
      entries: [
        ...PAGES.map((page) => ({
          key: `p:${page.to}`,
          label: page.label,
          go: () => void navigate({ to: page.to }),
        })),
        {
          key: 'p:keys',
          label: 'Keyboard shortcuts',
          verb: true,
          go: () => onHelpChange(true),
        },
      ],
    },
  ]
  // A chat on screen puts its verbs first; elsewhere Start from issue is the last thing the palette offers.
  const group: Group = { label: 'Commands', entries: commands }
  if (loop.length > 0) all.unshift(group)
  else all.push(group)
  const groups = all
    .map((group) => ({
      ...group,
      entries: group.entries.filter((one) =>
        `${one.label} ${one.terms ?? ''}`.toLowerCase().includes(query.toLowerCase()),
      ),
    }))
    .filter((group) => group.entries.length > 0)

  // A verb that is off stays on screen with its reason, and does nothing.
  const choose = (entry: Entry) => {
    if (!entry.off) go(entry.go, entry.verb)
  }

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
    <>
      <Dialog
        onOpenChange={onOpenChange}
        onOpenChangeComplete={(now) => {
          if (now || !after.current) return
          const run = after.current
          after.current = null
          run()
        }}
        open={open}
      >
        <DialogPopup className="palette" title="Search">
          <TextField
            aria-activedescendant={flat.length ? `${listId}-${current}` : undefined}
            aria-controls={listId}
            aria-describedby={legendId}
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
                choose(flat[current])
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
                      onClick={() => choose(entry)}
                      onMouseEnter={() => setActive(index)}
                      // 4.1.2: the cursor is `aria-activedescendant` on the
                      // field, so Tab must not walk the list as well.
                      aria-disabled={entry.off ? true : undefined}
                      render={<button type="button" role="option" tabIndex={-1} />}
                      tone={index === current ? 'selected' : 'plain'}
                    >
                      {entry.key.startsWith('w:') ? (
                        <Tile name={entry.label} />
                      ) : (
                        <IconTile>
                          {entry.key.startsWith('m:') ? <Cpu /> : entry.key.startsWith('c:') ? <Play /> : <FileText />}
                        </IconTile>
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
                      {entry.chord ? <Kbd>{entry.chord}</Kbd> : null}
                      {index === current && !entry.off ? <Kbd aria-hidden="true">Enter</Kbd> : null}
                    </Row>
                  )
                })}
              </div>
            ))}
            {flat.length === 0 ? <EmptyState title="Nothing matches" /> : null}
          </div>
          <div className="palette__foot">
            <span>
              {notes.length ? notes.join(' ') : 'Finds a place, or runs a step of the coding loop.'}
            </span>
            <span className="palette__legend" id={legendId}>
              <Kbd aria-hidden="true">↑↓</Kbd>
              <span className="m3-sr-only">Up and down arrows</span> move <Kbd>Enter</Kbd> open{' '}
              <Kbd>Esc</Kbd> close
            </span>
          </div>
        </DialogPopup>
      </Dialog>
    {starting ? (
      <StartSession item={starting} onOpenChange={(now) => now || setStarting(null)} open />
    ) : null}
    <KeyboardHelp onOpenChange={onHelpChange} open={help} />
    </>
  )
}
