import { useNavigate } from '@tanstack/react-router'
import type { Machine, Workspace } from '@/api'
import type { Reading } from '@/useLooked'
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from '@/components/ui/command'

/** D3 §3.2: every entry is a place. No entry is a verb, which is what keeps a
 *  destructive action further than two keystrokes from anywhere. */
type Entry =
  | { kind: 'workspace'; value: string; label: string }
  | { kind: 'machine'; value: string; label: string }
  | {
      kind: 'route'
      value: '/' | '/machines' | '/new' | '/settings' | '/usage'
      label: string
    }

type Group = { label: string; items: Entry[] }

const ROUTES: Entry[] = [
  { kind: 'route', value: '/', label: 'Fleet' },
  { kind: 'route', value: '/machines', label: 'Machines' },
  { kind: 'route', value: '/new', label: 'New workspace' },
  { kind: 'route', value: '/settings', label: 'Settings' },
  { kind: 'route', value: '/usage', label: 'Usage' },
]

/** No group at all for a class that could not be read: the note below says so
 *  in words, and a heading over nothing would be the wrong sentence. */
function offer(
  label: string,
  kind: 'workspace' | 'machine',
  query: Reading<{ name: string }[]>,
): Group[] {
  if (query.looked !== 'ok' || query.data.length === 0) return []
  const items = query.data.map(
    (one): Entry => ({ kind, value: one.name, label: one.name }),
  )
  return [{ label, items }]
}

/** R-23: a class nobody could read is not a class with nothing in it, so the
 *  palette names it rather than offering an empty group under its heading. */
function unread(name: string, query: Reading<unknown>): string | null {
  if (query.looked === 'ok') return null
  return query.looked === 'never'
    ? `${name} have not been read yet.`
    : `${name} could not be read.`
}

/** The overlay, in its own module because Base UI's combobox is the largest
 *  thing the header could pull in and nobody has summoned it on the first paint.
 *  The two readings stay in `Palette.tsx` so they are taken from the first paint
 *  as before — what waits for the chunk is the drawing, not the data. */
export function PalettePopup({
  open,
  onOpenChange,
  workspaces,
  machines,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaces: Reading<Workspace[]>
  machines: Reading<Machine[]>
}) {
  const navigate = useNavigate()

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
    onOpenChange(false)
    if (entry.kind === 'workspace') {
      void navigate({ to: '/w/$name', params: { name: entry.value } })
    } else if (entry.kind === 'machine') {
      void navigate({ to: '/m/$machine', params: { machine: entry.value } })
    } else {
      void navigate({ to: entry.value })
    }
  }

  return (
    <CommandDialog onOpenChange={onOpenChange} open={open}>
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
