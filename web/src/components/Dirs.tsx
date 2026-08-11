import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Dir, Listing, Probed } from '@/api'
import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
} from '@/components/ui/combobox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { dirOf, tailOf, trimSlash } from '@/lib/path'

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
  | { asked: 'failed'; status: number | null; said: string }

const post = async <T,>(path: string, body: unknown): Promise<Asked<T>> => {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      return {
        asked: 'failed',
        status: response.status,
        said: await response.text(),
      }
    }
    return { asked: 'read', data: (await response.json()) as T }
  } catch (cause) {
    // `null` is a request that never got an answer, which is not a refusal.
    return { asked: 'failed', status: null, said: String(cause) }
  }
}

const at = (machine: string) =>
  `/api/machines/${encodeURIComponent(machine)}/dirs`

const probeAt = (machine: string) =>
  `/api/machines/${encodeURIComponent(machine)}/probe`

/** D4 §4.2, amended 2026-08-11 (Y-304). **One box, holding the path**, the way
 *  a file dialog does it: what you type is where you are, the list under it is
 *  that directory filtered by the last segment, and `/` walks in.
 *
 *  **Only crossing a `/` costs a round trip.** The listing is keyed by the
 *  *directory* the box names, so `Do`, `Dow` and `Downl` are one request and
 *  three filters. D4 §2 measured a level at 0.23 s — a probe's price, which
 *  [ADR-0019](../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md)
 *  ruled a person may wait for — and this spends it once per level rather than
 *  once per keystroke. Walking back up costs nothing at all: every level stays
 *  in the query cache, which is why nothing here debounces.
 *
 *  **Taking a directory always probes it**, even one just listed. The listing
 *  says a directory is there; it does not say what origin it holds, and the
 *  name is derived from that. One round trip buys the origin and D4 §5's
 *  answer together, which is `probe`'s own reason for asking both at once. */
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
  const [text, setText] = useState('')
  const [seeded, setSeeded] = useState(false)
  const [open, setOpen] = useState(false)
  const [high, setHigh] = useState<Dir | undefined>(undefined)
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
    setText('')
    setSeeded(false)
    setOpen(false)
    setHigh(undefined)
    setProbing({ asked: 'no' })
  }

  /** **Nothing polls.** Each level is one ask and the answer is kept until you
   *  leave: a listing is a POST because it asks a machine (ADR-0019), not
   *  because it changes anything, and re-asking on a window focus would spend
   *  an ssh round trip nobody asked for. */
  const client = useQueryClient()
  const { data: listing = { asked: 'no' } as Asked<Listing>, isFetching } =
    useQuery({
      queryKey: ['dirs', machine, where],
      queryFn: async () => {
        const answer = await post<Listing>(
          at(machine),
          where === null ? {} : { path: where },
        )
        // `$HOME` is asked for by naming nothing, so its answer lands under a
        // key no typed path can ever produce. Mirroring it under the path it
        // turned out to be is what makes walking back up to it free.
        if (where === null && answer.asked === 'read')
          client.setQueryData(
            ['dirs', machine, trimSlash(answer.data.path)],
            answer,
          )
        return answer
      },
      enabled: machine !== '',
      // A failed listing has already spent a ConnectTimeout, and Query's default
      // is three more. D4 §2 is about not making a person wait; retrying is the
      // same mistake with nobody to see it.
      retry: false,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
    })

  const here = listing.asked === 'read' ? trimSlash(listing.data.path) : null
  const entries = listing.asked === 'read' ? listing.data.entries : []
  const parent = here !== null && here !== '/' ? dirOf(here) : null

  // The box holds a path, so it cannot start empty — and the machine's own
  // `$HOME` is a fact only the far side has. This is the render it arrives in.
  if (!seeded && here !== null) {
    setSeeded(true)
    setText(here === '/' ? '/' : `${here}/`)
  }

  // `..` first, as every file dialog puts it, and it is the whole up gesture:
  // a separate button would be a second control saying what one row says.
  const items: Dir[] =
    parent === null
      ? entries
      : [{ path: parent, name: '..', repo: false, origin: null }, ...entries]

  const typed = text.trim()
  const target = typed.startsWith('/') ? trimSlash(typed) : here

  const go = (path: string) => {
    setWhere(path)
    setText(path === '/' ? '/' : `${path}/`)
    setHigh(undefined)
  }

  const typing = (value: string) => {
    setText(value)
    // A person who started before `$HOME` arrived has said where they are
    // going, and the answer to a question they stopped asking must not land
    // on top of it.
    setSeeded(true)
    const dir = dirOf(value)
    // The one line that spends a round trip. Everything else the box does is
    // arithmetic over a listing that already arrived.
    if (dir !== null && dir !== here) setWhere(dir)
  }

  const take = async (path: string) => {
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

  return (
    <Field>
      <FieldLabel htmlFor="new-dirs">Directory</FieldLabel>

      <Combobox<Dir>
        // Filtered against the box's own value rather than the primitive's
        // `query` argument. They part company the moment an entry is taken:
        // the primitive keeps the name it matched, so the list would filter
        // the level you just walked into by the name of the way in.
        filter={(entry) => {
          const tail = tailOf(text).toLowerCase()
          return tail === '' || (entry as Dir).name.toLowerCase().includes(tail)
        }}
        inputValue={text}
        items={items}
        itemToStringLabel={(entry) => entry.name}
        onInputValueChange={(value, details) => {
          // `input-change` is a person typing, and it is the only reason worth
          // acting on. The port fixes `fillInputOnItemPress`, so taking an
          // entry **clears** the box and reports that as `input-clear` — which
          // would wipe the path `go` had just written into it.
          if (details.reason === 'input-change') typing(value)
        }}
        onItemHighlighted={(entry) => setHigh(entry)}
        onOpenChange={(next, details) => {
          // Taking an entry walks a level in, and the primitive reads that as a
          // choice and wants to close. **Going in is browsing, not deciding**,
          // so the list stays up and shows where you landed.
          if (!next && details.reason === 'item-press') return
          setOpen(next)
        }}
        onValueChange={(entry) => entry && go(entry.path)}
        open={open}
        value={null}
      >
        {/* No trigger: Base UI's own is named from this `Field`'s one label, so
            the box and the chevron would both be called *Directory*. The list
            opens on focus and on typing, which is what the box is for. */}
        <ComboboxInput
          id="new-dirs"
          // Focus is enough: the box exists to be walked, and a list that waits
          // for a keystroke hides the one thing a person came to read.
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            // With an entry highlighted, Enter is the primitive's and goes a
            // level in. With none, the box holds a whole path and Enter is the
            // confirm — never a form submit that would create a workspace
            // nobody has finished describing.
            if (event.key !== 'Enter' || high) return
            event.preventDefault()
            if (target !== null) void take(target)
          }}
          placeholder="/"
          showTrigger={false}
        />
        <ComboboxPopup>
          {isFetching && <ComboboxStatus>listing…</ComboboxStatus>}
          <ComboboxEmpty>
            {/* The shell's own glob skips dotfiles, so a directory that looks
                empty may hold only hidden ones — and typing one is how you
                reach it (D4 §3.1). */}
            {isFetching
              ? ''
              : entries.length === 0
                ? 'nothing here but files or hidden directories'
                : 'nothing here matches'}
          </ComboboxEmpty>
          <ComboboxList>
            {(entry: Dir) => (
              <ComboboxItem key={entry.path} value={entry}>
                <span className="font-mono">
                  {entry.name === '..' ? '..' : `${entry.name}/`}
                </span>
                {/* D4 §5: a directory with no origin is legitimate and blocks
                    nothing. It is usually a typo, so it is named. */}
                {entry.name !== '..' && (
                  <span className="text-muted-foreground ms-2 text-xs">
                    {entry.origin ??
                      (entry.repo ? 'no origin' : 'not a repository')}
                  </span>
                )}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={probing.asked === 'asking' || target === null}
          onClick={() => target !== null && void take(target)}
          size="sm"
          variant="outline"
        >
          {probing.asked === 'asking' ? 'checking…' : 'Use this directory'}
        </Button>
      </div>

      {/* The route tells *not there* from *could not ask* with its status, and
          so must this: D4 §5's whole rule is that they differ. A 409 while you
          are still typing a name is ordinary, so it says what is missing and
          nothing more. */}
      {listing.asked === 'failed' && (
        <p className="text-sm">
          {listing.status === 409
            ? `${machine} has no directory there.`
            : `${machine} could not be asked what is there.`}{' '}
          Type a whole path and use it anyway, or choose a machine that answers.
          <span className="text-muted-foreground mt-1 block font-mono text-xs whitespace-pre-wrap">
            {listing.said}
          </span>
        </p>
      )}

      <FieldDescription>
        Type to filter and <kbd>/</kbd> to go in;{' '}
        <span className="font-mono">..</span> goes up. Only crossing a{' '}
        <kbd>/</kbd> asks the machine.
        {chosen && ` Using ${chosen.path}.`}
      </FieldDescription>
    </Field>
  )
}
