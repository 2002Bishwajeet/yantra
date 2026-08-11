import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Dir, Listing, Probed } from '@/api'
import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from '@/components/ui/combobox'
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

/** The parent of an absolute path, or `null` at the root. */
function up(path: string): string | null {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : cut === 0 ? '/' : null
}

/** D4 §4.2. **Each step is one request and about 0.3 s**, which is what `probe`
 *  already costs and what [ADR-0019](../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md)
 *  ruled a person may wait for. It walks rather than searching because D4 §2
 *  measured a whole-home sweep at 8.5 s on this fleet's Mac.
 *
 *  **Two gestures, and the split is what the combobox buys.** Choosing an entry
 *  *goes there*; the button *takes where you are*. One list that meant both
 *  needed two controls per row and left a reader deciding which was which.
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
  const [typed, setTyped] = useState('')
  const [probing, setProbing] = useState<Asked<Probed>>({ asked: 'no' })
  // **The ported `ui/combobox` Omits `onOpenChange`**, so a caller may say when
  // the list is open and can never be told when the primitive wants it shut.
  // Focus and Escape are therefore ours; a click outside is nobody's. Reported
  // rather than worked around, because the fix is three characters in a file
  // ADR-0014 forbids editing.
  const [open, setOpen] = useState(false)

  // A path is a fact about one machine, so a new machine starts again. React's
  // own answer to adjusting state when an input changes — set it during the
  // render and let this pass be discarded, rather than an effect that paints
  // the old machine's listing first. The *choice* is the form's: it owns it and
  // outlives this component when no machine is picked.
  const [seen, setSeen] = useState(machine)
  if (seen !== machine) {
    setSeen(machine)
    setWhere(null)
    setTyped('')
    setProbing({ asked: 'no' })
    setOpen(false)
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
    // A failed listing has already spent a ConnectTimeout, and Query's default
    // is three more. D4 §2 is about not making a person wait; retrying is the
    // same mistake with nobody to see it.
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  })

  const asking = machine !== '' && listing.asked === 'no'
  const entries = listing.asked === 'read' ? listing.data.entries : []
  const here = listing.asked === 'read' ? listing.data.path : null
  const parent = here && up(here)
  // A path typed in full is a place to go, not a filter over this one.
  const elsewhere = typed.trim().startsWith('/') ? typed.trim() : null
  const target = elsewhere ?? here

  const go = (path: string) => {
    setWhere(path)
    setTyped('')
    setOpen(false)
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
    <>
      <Field>
        <FieldLabel htmlFor="new-dirs">Directory</FieldLabel>

        <Combobox<Dir>
          items={entries}
          itemToStringLabel={(entry) => entry.name}
          onValueChange={(entry) => entry && go(entry.path)}
          open={open}
          value={null}
        >
          {/* No trigger: Base UI's own names it from this `Field`'s one label,
            so the box and the chevron would both be called *Directory*. The
            list opens on focus and on typing, which is what the box is for. */}
          <ComboboxInput
            id="new-dirs"
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false)
            }}
            placeholder="go somewhere, or type a full path"
            showTrigger={false}
          />
          <ComboboxPopup>
            <ComboboxEmpty>
              {/* The shell's own glob skips dotfiles, so a directory that looks
                empty may hold only hidden ones — and a full path is how you
                reach one (D4 §3.1). */}
              {entries.length === 0
                ? 'nothing here but files or hidden directories'
                : 'nothing here matches'}
            </ComboboxEmpty>
            <ComboboxList>
              {(entry: Dir) => (
                <ComboboxItem key={entry.path} value={entry}>
                  <span className="font-mono">{entry.name}</span>
                  {/* D4 §5: a directory with no origin is legitimate and blocks
                    nothing. It is usually a typo, so it is named. */}
                  <span className="text-muted-foreground ms-2 text-xs">
                    {entry.origin ??
                      (entry.repo ? 'no origin' : 'not a repository')}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground font-mono text-xs">
            {here ?? '…'}
          </span>
          {parent && (
            <Button onClick={() => go(parent)} size="sm" variant="ghost">
              ↑ up
            </Button>
          )}
          <Button
            disabled={probing.asked === 'asking' || target === null}
            onClick={() => target && void take(target)}
            size="sm"
            variant="outline"
          >
            {probing.asked === 'asking'
              ? 'checking…'
              : elsewhere
                ? `Use ${elsewhere}`
                : 'Use this directory'}
          </Button>
        </div>

        {asking && (
          <div className="flex flex-col gap-2" data-slot="reading">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        )}

        {/* The route tells *not there* from *could not ask* with its status,
            and so must this: D4 §5's whole rule is that they differ. */}
        {listing.asked === 'failed' && (
          <p className="text-sm">
            {listing.status === 409
              ? `${machine} has no directory there.`
              : `${machine} could not be asked what is there.`}{' '}
            Type a full path and use it anyway, or choose a machine that
            answers.
            <span className="text-muted-foreground mt-1 block font-mono text-xs whitespace-pre-wrap">
              {listing.said}
            </span>
          </p>
        )}

        <FieldDescription>
          One level at a time, because a machine takes about as long to list a
          directory as to answer whether one is there.
          {chosen && ` Using ${chosen.path}.`}
        </FieldDescription>
      </Field>

      {/* Its own field, twice over. Base UI names every control in one from
          that one's label — and **a `Combobox` with nothing in `items` stops
          reporting what is typed into it**, which is exactly the state a
          machine that could not be listed leaves you in, and the one state
          this escape hatch exists for. */}
      <Field>
        <FieldLabel htmlFor="new-path">Path</FieldLabel>
        <Input
          autoComplete="off"
          id="new-path"
          onChange={(event) => setTyped(event.target.value)}
          placeholder="or type a full one"
          value={typed}
        />
      </Field>
    </>
  )
}
