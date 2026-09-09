import { useEffect, useEffectEvent, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Folder, FolderGit2 } from 'lucide-react'
import type { Dir, Probed } from '@/api'
import { asApiError, isApiError } from '@/api/errors'
import { useMakeDir } from '@/api/mutations'
import { dirsQuery, probeQuery } from '@/api/queries'
import { derive } from '@/lib/name'
import { trimSlash } from '@/lib/path'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Lead } from '@/m3/lead/Lead'
import { Row, RowText } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { crumbs } from './dirs'
import { slug, tilde, type Values } from './form'
import type { SessionForm } from './useSessionForm'

const badge = (entry: Dir): string =>
  entry.origin ? `git · ${slug(entry.origin)}` : entry.repo ? 'git · no origin' : 'not a repository'

function Breadcrumb(props: { here: string; home: string | null; onGo: (path: string | null) => void }) {
  const { here, home, onGo } = props
  const parts = crumbs(here, home)
  return (
    <nav aria-label="Where you are" className="ns__crumbs">
      <ol>
        {parts.map((part, index) => {
          const last = index === parts.length - 1
          return (
            <li key={part.path}>
              {last ? (
                <span aria-current="location" className="ns__crumb">
                  {part.label}
                </span>
              ) : (
                <button className="ns__crumb m3-interactive" onClick={() => onGo(part.path === home ? null : part.path)} type="button">
                  {part.label}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

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
        supporting={`under ${here}/`}
        value={folder}
      />
      <Button
        disabled={!usable || make.isPending}
        onClick={() =>
          make.mutate(
            { machine, path: here, make: trimmed },
            { onSuccess: () => onMade(`${here}/${trimmed}`) },
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

/** The local half of step 2 (NewSessionLocal): one level per walk, the
 *  folder you are in is the choice, and typing a path is the way in when
 *  the listing is long or the machine cannot list (D4 §4.2). */
export function LocalDirs(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  const machine = values.machine
  const client = useQueryClient()
  // `null` is the machine's own `$HOME`, which only the far side can name.
  const [where, setWhere] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [probing, setProbing] = useState(false)
  const home = useQuery({ ...dirsQuery(machine, null), enabled: true })
  const listing = useQuery({ ...dirsQuery(machine, where), enabled: true })
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

  const walk = (entry: Dir) => {
    setWhere(entry.path)
    setTyped('')
    choose(entry.path, entry.origin, 'yes')
  }

  const takeTyped = async () => {
    const path = trimSlash(typed.trim())
    if (!path.startsWith('/')) return
    setProbing(true)
    // R-23: a machine that could not be asked is not the path being absent —
    // D4 §5 lets that through and says so.
    const probed: Probed | Error = await client
      .fetchQuery(probeQuery(machine, path))
      .catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))
    setProbing(false)
    if (probed instanceof Error) {
      choose(path, null, 'unknown', isApiError(probed) ? probed.said : probed.message)
    } else {
      choose(path, probed.origin, probed.exists ? 'yes' : 'no')
    }
  }

  const source = values.source?.kind === 'local' ? values.source : null

  return (
    <div className="ns__local">
      <Text render={<p />} scale="body-medium" tone="variant">
        browsing {machine} over the open ssh connection
      </Text>
      {here !== null ? <Breadcrumb here={here} home={root} onGo={setWhere} /> : null}

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
          title={
            asApiError(listing.error).status === 409
              ? `${machine} has no directory there`
              : `${machine} could not be asked what is there`
          }
        />
      ) : (
        <ul aria-label="Folders" className="ns__list">
          {listing.data.entries.length === 0 ? (
            <li>
              <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
                nothing here but files or hidden directories
              </Text>
            </li>
          ) : null}
          {listing.data.entries.map((entry) => (
            <li key={entry.path}>
              <Row onClick={() => walk(entry)} render={<button type="button" />}>
                <Lead tone={entry.repo ? 'primary' : undefined}>
                  {entry.repo ? <FolderGit2 /> : <Folder />}
                </Lead>
                <RowText headline={entry.name} supporting={badge(entry)} />
              </Row>
            </li>
          ))}
        </ul>
      )}

      {here !== null ? (
        <NewFolder
          here={here}
          key={here}
          machine={machine}
          name={values.name}
          onMade={(path) => {
            setWhere(path)
            choose(path, null, 'yes')
          }}
        />
      ) : null}

      <div className="ns__make">
        <TextField
          autoComplete="off"
          label="Or type a path"
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            void takeTyped()
          }}
          onValueChange={setTyped}
          supporting="absolute, on this machine; it is checked before anything is written"
          value={typed}
        />
        <Button disabled={probing || !typed.trim().startsWith('/')} onClick={() => void takeTyped()} type="button" variant="tonal">
          {probing ? 'checking…' : 'Use'}
        </Button>
      </div>

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
