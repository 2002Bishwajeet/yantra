import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
import type { Listed, Looked, Machine } from '@/api'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { loaded, useLooked } from '@/useLooked'

/** D3 §3.2: every entry is a place. No entry is a verb, which is what keeps a
 *  destructive action further than two keystrokes from anywhere. */
type Entry =
  | { kind: 'workspace'; value: string; label: string }
  | { kind: 'machine'; value: string; label: string }
  | { kind: 'route'; value: '/' | '/machines' | '/usage'; label: string }

type Group = { label: string; items: Entry[] }

const ROUTES: Entry[] = [
  { kind: 'route', value: '/', label: 'Fleet' },
  { kind: 'route', value: '/machines', label: 'Machines' },
  { kind: 'route', value: '/usage', label: 'Usage' },
]

// The listener takes either modifier; this only says which one to press.
const SHORTCUT = navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl K'

/** No group at all for a class that could not be read: the note below says so
 *  in words, and a heading over nothing would be the wrong sentence. */
function offer(
  label: string,
  kind: 'workspace' | 'machine',
  query: Looked<{ name: string }[]>,
): Group[] {
  if (query.looked !== 'ok' || query.data.length === 0) return []
  const items = query.data.map(
    (one): Entry => ({ kind, value: one.name, label: one.name }),
  )
  return [{ label, items }]
}

/** R-23: a class nobody could read is not a class with nothing in it, so the
 *  palette names it rather than offering an empty group under its heading. */
function unread(name: string, query: Looked<unknown>): string | null {
  if (query.looked === 'ok') return null
  return query.looked === 'never'
    ? `${name} have not been read yet.`
    : `${name} could not be read.`
}

export function Palette() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  // The two readings the pages already take, under the same keys — so the
  // palette shares their cache rather than polling a third copy.
  const workspaces = loaded(useLooked<Listed[]>('/api/workspaces'))
  const machines = useLooked<Machine[]>('/api/machines')

  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setOpen((was) => !was)
    }
    document.addEventListener('keydown', pressed)
    return () => document.removeEventListener('keydown', pressed)
  }, [])

  const groups: Group[] = [
    ...offer('Workspaces', 'workspace', workspaces),
    ...offer('Machines', 'machine', machines),
    { label: 'Routes', items: ROUTES },
  ]

  const notes = [
    unread('Workspaces', workspaces),
    unread('Machines', machines),
  ].filter((one) => one !== null)

  const go = (entry: Entry) => {
    setOpen(false)
    if (entry.kind === 'workspace') {
      void navigate({ to: '/w/$name', params: { name: entry.value } })
    } else if (entry.kind === 'machine') {
      void navigate({ to: '/m/$machine', params: { machine: entry.value } })
    } else {
      void navigate({ to: entry.value })
    }
  }

  return (
    <CommandDialog onOpenChange={setOpen} open={open}>
      {/* D3 §10: a phone has no ⌘K, so the shortcut is a hint on a control that
          can be tapped rather than the only way in. */}
      <CommandDialogTrigger render={<Button size="sm" variant="outline" />}>
        <SearchIcon />
        Search
        <Kbd className="max-sm:hidden">{SHORTCUT}</Kbd>
      </CommandDialogTrigger>

      <CommandDialogPopup aria-label="Search">
        <Command items={groups}>
          <CommandInput
            aria-label="Search"
            placeholder="Workspaces, machines and routes"
          />
          <CommandPanel>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandList>
              {(group: Group) => (
                <CommandGroup items={group.items} key={group.label}>
                  <CommandGroupLabel>{group.label}</CommandGroupLabel>
                  <CommandCollection>
                    {(entry: Entry) => (
                      <CommandItem
                        key={entry.value}
                        onClick={() => go(entry)}
                        value={entry}
                      >
                        {entry.label}
                      </CommandItem>
                    )}
                  </CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          {notes.length > 0 && <CommandFooter>{notes.join(' ')}</CommandFooter>}
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  )
}
