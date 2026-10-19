import { type KeyboardEvent, useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Entry, Listing, Probed } from '@/api'
import { asApiError, isApiError } from '@/api/errors'
import { useMakeDir } from '@/api/mutations'
import { dirsQuery, probeQuery } from '@/api/queries'
import { derive } from '@/lib/name'
import { dirOf, trimSlash } from '@/lib/path'
import { Button } from '@/m3/button/Button'
import { FilterChip } from '@/m3/chip/Chip'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { usePrefs } from '@/shell/prefs'
import { noAccess, under } from './dirs'
import { FolderTree } from './FolderTree'
import { slug, tilde, type Values } from './form'
import { FOLDER_KEYS, folderKeys, typing } from './keys'
import { PathBar } from './PathBar'
import { arrange, lastFolder, recentFolders } from './picker'
import type { SessionForm } from './useSessionForm'

function NewFolder(props: { machine: string; here: string; name: string; onMade: (path: string) => void }) {
  const { machine, here, name, onMade } = props
  const [folder, setFolder] = useState(name)
  const make = useMakeDir()
  const trimmed = folder.trim()
  const usable = trimmed !== '' && !trimmed.includes('/')
  return (
    <div className="ns__make">
      <TextField
        autoComplete="off"
        error={make.error ? make.error.said : undefined}
        label="New folder"
        onValueChange={setFolder}
        supporting={`under ${here === '/' ? '/' : `${here}/`}`}
        value={folder}
      />
      <Button
        disabled={!usable || make.isPending}
        onClick={() =>
          make.mutate(
            { machine, path: here, make: trimmed },
            { onSuccess: () => onMade(under(here, trimmed)) },
          )
        }
        type="button"
        variant="tonal"
      >
        {make.isPending ? 'making…' : 'Make'}
      </Button>
    </div>
  )
}

/** Why a listing draws no rows: four different answers, never one sentence
 *  true of all of them (R-23). */
function nothing(listing: Listing, machine: string, filter: string, folder: string): string {
  if (!listing.access) return noAccess(machine)
  if (listing.entries.length === 0) return 'this folder is empty'
  if (filter.trim() !== '') return `nothing in ${folder} matches ${filter.trim()}`
  return 'nothing here but hidden entries'
}

/** The local half of step 2 (NewSessionLocal): one level per walk, the
 *  folder you are in is the choice, and it behaves like a file browser: a
 *  path bar, a filter, arrow keys, and a start at the last folder used on
 *  this machine (Y-516). */
export function LocalDirs(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  const machine = values.machine
  const client = useQueryClient()
  const prefs = usePrefs()
  // The folder this machine opened at last time; if it is gone, `$HOME` and a note.
  const [remembered] = useState(() => lastFolder(prefs, machine))
  // `null` is the machine's own `$HOME`, which only the far side can name.
  const [where, setWhere] = useState<string | null>(remembered)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState<string | null>(null)
  // Off by default: a home's dotfiles outnumber its projects (Y-414).
  const [hidden, setHidden] = useState(false)
  const list = useRef<HTMLUListElement>(null)
  const keys = useId()
  const home = useQuery({ ...dirsQuery(machine, null), enabled: true })
  const asked = useQuery({ ...dirsQuery(machine, where), enabled: true })
  const refusedAt = asked.error ? asApiError(asked.error).status : null
  const gone = where !== null && where === remembered && (refusedAt === 404 || refusedAt === 409)
  const listing = gone ? home : asked
  const root = home.data ? trimSlash(home.data.path) : null
  const here = listing.data ? trimSlash(listing.data.path) : null

  const choose = (path: string, origin: string | null, checked: 'yes' | 'no' | 'unknown', because?: string) => {
    form.setFieldValue('source', { kind: 'local', path, origin, checked, because })
    if (!values.named) form.setFieldValue('name', derive(path, origin))
  }

  // The folder you are in is the choice, and `$HOME` is a fact that arrives
  // with the first listing rather than one the page can write before it.
  const chosen = values.source?.kind === 'local' ? values.source.path : null
  const arrived = useEffectEvent((path: string) => {
    if (chosen !== path) form.setFieldValue('source', { kind: 'local', path, origin: null, checked: 'yes' })
  })
  useEffect(() => {
    if (here !== null) arrived(here)
  }, [here])

  const go = (path: string | null) => {
    setWhere(path)
    setFilter('')
    setActive(null)
  }

  const walk = (entry: Entry) => {
    go(entry.path)
    choose(entry.path, entry.origin, 'yes')
  }

  // Typing a path and pressing a recent folder both ask the machine first.
  const visit = async (typed: string) => {
    const path = trimSlash(typed.trim())
    // R-23: a machine that could not be asked is not the path being absent —
    // D4 §5 lets that through and says so.
    const probed: Probed | Error = await client
      .fetchQuery(probeQuery(machine, path))
      .catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))
    if (probed instanceof Error) {
      choose(path, null, 'unknown', isApiError(probed) ? probed.said : probed.message)
      return
    }
    if (probed.exists) go(path === root ? null : path)
    choose(path, probed.origin, probed.exists ? 'yes' : 'no')
  }

  const source = values.source?.kind === 'local' ? values.source : null
  const shown = listing.data ? arrange(listing.data.entries, { hidden, filter }) : []
  const first = shown.find((entry) => entry.kind === 'dir' && entry.access)?.path
  const tab = (path: string): 0 | -1 => (path === (active ?? first) ? 0 : -1)
  const recent = recentFolders(prefs, machine)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Backspace' || typing(event.target) || event.altKey || event.ctrlKey || event.metaKey) return
    const up = here === null ? null : dirOf(here)
    if (here === null || here === '/' || up === null) return
    event.preventDefault()
    go(up === root ? null : up)
  }

  return (
    <div className="ns__local" onKeyDown={onKeyDown} role="presentation">
      <Text render={<p />} scale="body-medium" tone="variant">
        browsing {machine} over the open ssh connection
      </Text>

      {recent.length > 0 ? (
        <section aria-labelledby={`${keys}-recent`} className="ns__recents">
          <Text id={`${keys}-recent`} render={<h3 />} scale="label-large" tone="variant">
            Recent on {machine}
          </Text>
          <ul>
            {recent.map((path) => (
              <li key={path}>
                <button className="ns__crumb m3-interactive" onClick={() => void visit(path)} type="button">
                  {tilde(path, root)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="ns__where">
        {here !== null ? <PathBar here={here} home={root} onEdit={visit} onGo={go} /> : null}
        <FilterChip onPressedChange={setHidden} pressed={hidden}>
          Show hidden
        </FilterChip>
      </div>

      {gone ? (
        <Text render={<p role="status" />} className="ns__note" scale="body-medium" tone="variant">
          {`${where} is gone; showing home`}
        </Text>
      ) : null}

      <TextField
        autoComplete="off"
        label="Filter this folder"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          list.current?.querySelector<HTMLElement>('[data-row]')?.focus()
        }}
        onValueChange={(value) => {
          setFilter(value)
          setActive(null)
        }}
        value={filter}
      />

      {listing.isPending ? (
        <div aria-busy="true" className="ns__list">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : listing.error ? (
        <ErrorSurface.Inline
          error={asApiError(listing.error)}
          reset={() => void listing.refetch()}
          title={listing.error && asApiError(listing.error).status === 409 ? `${machine} has no directory there` : `${machine} could not be asked what is there`}
        />
      ) : (
        <>
          <span className="m3-sr-only" id={keys}>
            {FOLDER_KEYS}
          </span>
          <ul
            aria-describedby={keys}
            aria-label="Folders"
            className="ns__list"
            onFocus={(event) => {
              const at = event.target instanceof HTMLElement ? event.target.closest('.ns__node') : null
              const path = at?.querySelector<HTMLElement>('[data-row]')?.dataset.path
              if (path) setActive(path)
            }}
            onKeyDown={folderKeys}
            ref={list}
          >
            {shown.length === 0 ? (
              <li>
                <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
                  {nothing(listing.data, machine, filter, tilde(here ?? '', root))}
                </Text>
              </li>
            ) : null}
            <FolderTree entries={shown} hidden={hidden} machine={machine} onWalk={walk} tab={tab} />
            {listing.data.truncated ? (
              <li>
                <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
                  {`${machine} sent the first ${listing.data.entries.length} entries and stopped. Type a path to reach the rest.`}
                </Text>
              </li>
            ) : null}
          </ul>
        </>
      )}

      {here !== null ? (
        <NewFolder
          here={here}
          key={here}
          machine={machine}
          name={values.name}
          onMade={(path) => {
            go(path)
            choose(path, null, 'yes')
          }}
        />
      ) : null}

      {source ? (
        <p className="ns__chosen">
          <Mono>{tilde(source.path, root)}</Mono>
          <Text scale="body-small" tone={source.checked === 'no' ? 'error' : 'variant'}>
            {source.checked === 'no'
              ? `${machine} has no directory at ${source.path}. Make it there, or choose another.`
              : source.checked === 'unknown'
                ? `${machine} could not be asked, so this path is unchecked. It will be tried when the workspace is opened.`
                : source.origin
                  ? slug(source.origin)
                  : 'not a git repository — fine, if that is what you meant'}
          </Text>
          {source.because ? <Mono className="ns__because">{source.because}</Mono> : null}
        </p>
      ) : null}
    </div>
  )
}
