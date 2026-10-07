import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { asApiError } from '@/api/errors'
import { dirsQuery } from '@/api/queries'
import { trimSlash } from '@/lib/path'
import { Button } from '@/m3/button/Button'
import { FilterChip } from '@/m3/chip/Chip'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { FolderTree } from './FolderTree'
import { tilde } from './form'
import { Breadcrumb } from './LocalDirs'

/** The folder picker behind "Change": the Local browser's rows, and the
 *  folder you are in is the one that is used. */
function Picker(props: {
  machine: string
  start: string
  root: string | null
  onUse: (path: string) => void
  onCancel: () => void
}) {
  const { machine, start, root, onUse, onCancel } = props
  const [where, setWhere] = useState(start)
  const [hidden, setHidden] = useState(false)
  const listing = useQuery({ ...dirsQuery(machine, where), enabled: true })
  const here = listing.data ? trimSlash(listing.data.path) : null
  const dirs = listing.data?.entries.filter((one) => one.kind === 'dir' && (hidden || !one.name.startsWith('.'))) ?? []

  return (
    <div className="ns__picker">
      <div className="ns__where">
        {here !== null ? <Breadcrumb here={here} home={root} onGo={(path) => setWhere(path ?? root ?? '/')} /> : null}
        <FilterChip onPressedChange={setHidden} pressed={hidden}>
          Show hidden
        </FilterChip>
      </div>
      {listing.isPending ? (
        <div aria-busy="true" className="ns__list">
          <Skeleton />
        </div>
      ) : listing.error ? (
        <ErrorSurface.Inline
          error={asApiError(listing.error)}
          reset={() => void listing.refetch()}
          title={`${machine} could not be asked what is there`}
        />
      ) : (
        <ul aria-label="Clone folder choices" className="ns__list">
          {dirs.length === 0 ? (
            <li>
              <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
                no folders here
              </Text>
            </li>
          ) : null}
          <FolderTree entries={dirs} hidden={hidden} machine={machine} onWalk={(entry) => setWhere(entry.path)} />
        </ul>
      )}
      <div className="ns__clone">
        <Button disabled={here === null} onClick={() => here !== null && onUse(here)} type="button" variant="tonal">
          {here === null ? 'Use this folder' : `Use ${tilde(here, root)}`}
        </Button>
        <Button onClick={onCancel} type="button" variant="text">
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** `Clone folder: ~/Documents/Github · Change`, and the picker under it. */
export function CloneFolder(props: {
  machine: string
  folder: string
  root: string | null
  onUse: (path: string) => void
}) {
  const { machine, folder, root, onUse } = props
  const [changing, setChanging] = useState(false)
  return (
    <div className="ns__clonefolder">
      <p className="ns__clone">
        <Text scale="body-medium" tone="variant">
          Clone folder:
        </Text>
        <Mono>{tilde(folder, root)}</Mono>
        <Button aria-expanded={changing} onClick={() => setChanging(!changing)} type="button" variant="text">
          Change
        </Button>
      </p>
      {changing ? (
        <Picker
          machine={machine}
          onCancel={() => setChanging(false)}
          onUse={(path) => {
            setChanging(false)
            onUse(path)
          }}
          root={root}
          start={folder}
        />
      ) : null}
    </div>
  )
}
