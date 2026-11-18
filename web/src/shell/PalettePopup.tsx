import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Cpu, FileText, MessageSquare, Play, TriangleAlert } from 'lucide-react'
import type { Item } from '@/api'
import { useThreadSearch } from '@/api/queries'
import { loaded, useAgents, useAttention, useMachines, useWorkspaces, type Reading } from '@/api/hooks'
import { Kbd } from '@/m3/kbd/Kbd'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Row, RowText } from '@/m3/row/Row'
import { SearchView } from '@/m3/search-view/SearchView'
import { IconTile, Tile } from '@/m3/tile/Tile'
import { StartSession } from '@/screens/fleet/StartSession'
import { useTick } from '@/useTick'
import { keyOf, type LoopId } from '@/screens/session/keys'
import { elapsed } from '@/screens/session/threads'
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

/** An empty list is told apart from a list nobody could read. */
function noIssue(looked: Reading<unknown>['looked']): string {
  if (looked === 'pending') return 'The issues are still being read.'
  if (looked === 'never') return 'The issues have not been read yet.'
  if (looked === 'failed') return 'GitHub could not be asked, so no issue is listed.'
  return NO_ISSUE
}

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
  /** Where the focus goes back to on close; null leaves it to Base UI. */
  opener: RefObject<HTMLElement | null>
  onHelpChange: (open: boolean) => void
  /** A query to put in the field, such as the issue chord's. */
  seed: { query: string } | null
}) {
  const { open, onOpenChange, help, onHelpChange, opener, seed } = props
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const legendId = useId()
  const workspaces = loaded(useWorkspaces())
  const agents = useAgents(workspaces)
  const machines = useMachines()
  const attention = useAttention()
  // Y-689: the store is asked once a person pauses on some text, and only while the palette is open.
  const [asked, setAsked] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setAsked(query), 150)
    return () => clearTimeout(timer)
  }, [query])
  const now = useTick(open)
  const threads = useThreadSearch(asked.trim(), open && asked.trim() !== '')
  const loop = useLoopCommands()
  const [starting, setStarting] = useState<Item | null>(null)
  // A verb waits for the palette to finish closing, so its dialog is not opened under the focus the palette hands back.
  const after = useRef<(() => void) | null>(null)

  // A pick or the New session link navigates away; the dialog must not outlive the page it was asked on.
  const href = useRouterState({ select: (state) => state.location.href })
  const [seen, setSeen] = useState(href)
  if (href !== seen) {
    setSeen(href)
    setStarting(null)
  }

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

  const noneReason = noIssue(attention.looked)
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
            supporting: noneReason,
            off: noneReason,
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
      label: 'Threads',
      entries: (query.trim() === '' ? [] : (threads.data ?? [])).map((one) => {
        const machine = machines.looked === 'ok' ? machines.data.find((m) => m.name === one.machine) : undefined
        const away =
          one.status === 'gone'
            ? 'gone'
            : machine && !machine.online
              ? one.seen === null
                ? 'offline'
                : `offline · seen ${elapsed(one.seen, now)} ago`
              : null
        const where = `${one.workspace} · ${one.machine}`
        return {
          key: `t:${one.workspace}:${one.id}`,
          label: one.title ?? 'Untitled thread',
          supporting: away ? `${where} · ${away}` : where,
          terms: where,
          go: () =>
            void navigate({
              to: '/w/$name',
              params: { name: one.workspace },
              search: { view: 'chat', thread: one.id },
            }),
        }
      }),
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
  const notes = [
    unread('Workspaces', workspaces),
    unread('Machines', machines),
    threads.isError ? 'Threads could not be read.' : null,
  ].filter((one) => one !== null)

  // 2.4.7: the list is 50vh and scrolls, so the arrow keys have to bring the
  // option they moved to with them. Optional because jsdom has no such method.
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [listId, current])

  return (
    <>
      <SearchView
        finalFocus={() => opener.current ?? true}
        input={{
          'aria-activedescendant': flat.length ? `${listId}-${current}` : undefined,
          'aria-controls': listId,
          'aria-describedby': legendId,
          'aria-expanded': true,
          autoFocus: true,
          onKeyDown: (event) => {
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
          },
          role: 'combobox',
        }}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={(now) => {
          if (now || !after.current) return
          const run = after.current
          after.current = null
          run()
        }}
        onValueChange={(value) => {
          setQuery(value)
          setActive(0)
        }}
        open={open}
        value={query}
      >
        <span className="m3-sr-only" id={legendId}>
          Up and down arrows move, Enter open, Esc close.
        </span>
        {notes.map((note) => (
          <div className="palette__note" key={note} role="note">
            <TriangleAlert aria-hidden="true" />
            {note}
          </div>
        ))}
        <div className="palette__list" id={listId} role="listbox" aria-label="Places">
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <div aria-hidden="true" className="palette__label">
                {group.label}
              </div>
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
                        {entry.key.startsWith('m:') ? (
                          <Cpu />
                        ) : entry.key.startsWith('t:') ? (
                          <MessageSquare />
                        ) : entry.key.startsWith('c:') ? (
                          <Play />
                        ) : (
                          <FileText />
                        )}
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
                    {entry.chord ? <Kbd className="palette__hint">{entry.chord}</Kbd> : null}
                    {index === current && !entry.off ? (
                      <Kbd aria-hidden="true" className="palette__hint">
                        Enter
                      </Kbd>
                    ) : null}
                  </Row>
                )
              })}
            </div>
          ))}
          {flat.length === 0 ? <EmptyState title="Nothing matches" /> : null}
        </div>
      </SearchView>
    {starting ? (
      <StartSession item={starting} onOpenChange={(now) => now || setStarting(null)} open />
    ) : null}
    <KeyboardHelp onOpenChange={onHelpChange} open={help} />
    </>
  )
}
