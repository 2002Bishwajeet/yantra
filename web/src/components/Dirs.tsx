import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Dir, Listing, Probed } from '@/api'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

/** What the form may write. `checked` is D4 §5's three answers rather than two:
 *  *absent* and *could not ask* are different, and only one of them blocks. */
export type Chosen = {
  path: string
  origin: string | null
  checked: 'yes' | 'no' | 'unknown'
  /** Why it could not be checked, said where the row says it. */
  because?: string
}

type Asked<T> =
  | { asked: 'no' }
  | { asked: 'asking' }
  | { asked: 'read'; data: T }
  | { asked: 'failed'; said: string }

const post = async <T,>(path: string, body: unknown): Promise<Asked<T>> => {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      return { asked: 'failed', said: await response.text() }
    }
    return { asked: 'read', data: (await response.json()) as T }
  } catch (cause) {
    return { asked: 'failed', said: String(cause) }
  }
}

const at = (machine: string) =>
  `/api/machines/${encodeURIComponent(machine)}/dirs`

const probeAt = (machine: string) =>
  `/api/machines/${encodeURIComponent(machine)}/probe`

/** The parent of an absolute path, or `null` at the root. */
function up(path: string): string | null {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : cut === 0 ? '/' : null
}

/** D4 §4.2: **each step is one request and about 0.3 s**, which is what `probe`
 *  already costs and what [ADR-0019](../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md)
 *  ruled a person may wait for. It walks rather than searching because D4 §2
 *  measured a whole-home sweep at 8.5 s on this fleet's Mac.
 *
 *  **The filter is an `Input` over the list rather than `ui/combobox`**, which
 *  D4 §4.2 named. The list is already on screen and already navigable, so a
 *  combobox would put a second scrolling surface over one that is there —
 *  reported as a deviation rather than taken quietly. */
export function Dirs({
  machine,
  chosen,
  onChoose,
}: {
  machine: string
  chosen: Chosen | null
  onChoose: (chosen: Chosen | null) => void
}) {
  // `null` is the machine's own `$HOME`, which only the far side can name.
  const [where, setWhere] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [typed, setTyped] = useState('')
  const [probing, setProbing] = useState<Asked<Probed>>({ asked: 'no' })

  // A path is a fact about one machine, so a new machine starts again. React's
  // own answer to adjusting state when an input changes — set it during the
  // render and let this pass be discarded, rather than an effect that paints
  // the old machine's listing first. The *choice* is the form's: it owns it and
  // outlives this component when no machine is picked.
  const [seen, setSeen] = useState(machine)
  if (seen !== machine) {
    setSeen(machine)
    setWhere(null)
    setFilter('')
    setTyped('')
    setProbing({ asked: 'no' })
  }

  /** **Nothing polls.** Each step is one ask and the answer is kept until you
   *  move: a listing is a POST because it asks a machine (ADR-0019), not
   *  because it changes anything, and re-asking on a window focus would spend
   *  an ssh round trip nobody asked for. */
  const { data: listing = { asked: 'no' } as Asked<Listing> } = useQuery({
    queryKey: ['dirs', machine, where],
    queryFn: () =>
      post<Listing>(at(machine), where === null ? {} : { path: where }),
    enabled: machine !== '',
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  })

  const enter = (path: string) => {
    setWhere(path)
    setFilter('')
  }

  const take = (entry: Dir) =>
    onChoose({ path: entry.path, origin: entry.origin, checked: 'yes' })

  const ask = async () => {
    const path = typed.trim()
    if (!path) return
    setProbing({ asked: 'asking' })
    const answer = await post<Probed>(probeAt(machine), { path })
    setProbing(answer)
    if (answer.asked === 'read') {
      onChoose({
        path,
        origin: answer.data.origin,
        checked: answer.data.exists ? 'yes' : 'no',
      })
    } else if (answer.asked === 'failed') {
      // R-23: the machine could not be asked, which is not the directory being
      // absent — D4 §5 lets this through and says so.
      onChoose({ path, origin: null, checked: 'unknown', because: answer.said })
    }
  }

  const asking = machine !== '' && listing.asked === 'no'
  const entries =
    listing.asked === 'read'
      ? listing.data.entries.filter((one) =>
          one.name.toLowerCase().includes(filter.trim().toLowerCase()),
        )
      : []
  const here = listing.asked === 'read' ? listing.data.path : null
  const parent = here && up(here)

  return (
    <>
      <Field>
        <FieldLabel htmlFor="new-filter">Directory</FieldLabel>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground font-mono text-xs">
            {here ?? '…'}
          </span>
          {parent && (
            <Button onClick={() => enter(parent)} size="sm" variant="ghost">
              ↑ up
            </Button>
          )}
        </div>

        <Input
          autoComplete="off"
          id="new-filter"
          onChange={(event) => setFilter(event.target.value)}
          placeholder="filter this directory"
          value={filter}
        />

        <div className="rounded-md border" data-slot="dirs">
          {asking && (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-64" />
            </div>
          )}

          {listing.asked === 'failed' && (
            <p className="p-3 text-sm">
              {machine} could not be asked what is there. Type a path below, or
              choose a machine that answers.
              <span className="text-muted-foreground mt-1 block font-mono text-xs whitespace-pre-wrap">
                {listing.said}
              </span>
            </p>
          )}

          {listing.asked === 'read' && entries.length === 0 && (
            <p className="text-muted-foreground p-3 text-sm">
              {listing.data.entries.length === 0
                ? // `*/` skips dotfiles, which is the shell's own default — so a
                  // directory that looks empty may hold only hidden ones (D4 §3.1).
                  'nothing here but files or hidden directories — type a path to reach one'
                : 'nothing here matches'}
            </p>
          )}

          {entries.map((entry) => (
            <div
              className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1 first:border-t-0 md:min-h-10"
              key={entry.path}
            >
              <Button
                className="font-mono"
                onClick={() => enter(entry.path)}
                size="sm"
                variant="ghost"
              >
                {entry.name}
              </Button>
              {/* D4 §5: a directory with no origin is legitimate and blocks
                nothing. It is usually a typo, so it is named. */}
              <span className="text-muted-foreground text-xs">
                {entry.origin ??
                  (entry.repo ? 'no origin' : 'not a repository')}
              </span>
              <Button
                className="ml-auto"
                disabled={chosen?.path === entry.path}
                onClick={() => take(entry)}
                size="sm"
                variant="outline"
              >
                {chosen?.path === entry.path ? 'chosen' : 'Use'}
              </Button>
            </div>
          ))}
        </div>

        <FieldDescription>
          One level at a time, because a machine takes about as long to list a
          directory as to answer whether one is there.
        </FieldDescription>
      </Field>

      {/* Its own field, because Base UI names every control in one from that
          one's label — two controls that are not the same question. */}
      <Field>
        <FieldLabel htmlFor="new-path">Path</FieldLabel>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            autoComplete="off"
            id="new-path"
            onChange={(event) => setTyped(event.target.value)}
            placeholder="or type one"
            value={typed}
          />
          <Button
            disabled={probing.asked === 'asking' || typed.trim() === ''}
            onClick={() => void ask()}
            size="sm"
            variant="outline"
          >
            {probing.asked === 'asking' ? 'checking…' : 'Check'}
          </Button>
        </div>
      </Field>
    </>
  )
}
