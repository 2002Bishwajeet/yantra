import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, File, Folder, FolderGit2, FolderLock } from 'lucide-react'
import type { Entry } from '@/api'
import { asApiError } from '@/api/errors'
import { dirsQuery } from '@/api/queries'
import { Lead } from '@/m3/lead/Lead'
import { Row, RowText } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { noAccess } from './dirs'
import { slug } from './form'

const badge = (entry: Entry): string =>
  entry.origin ? `git · ${slug(entry.origin)}` : entry.repo ? 'git · no origin' : 'not a repository'

const note = (text: string) => (
  <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
    {text}
  </Text>
)

type Walk = { machine: string; hidden: boolean; onWalk: (entry: Entry) => void }

/** The folders under one folder, fetched when it opens: one level per
 *  request, as everywhere else (D4 §2). Files are not drawn here. */
function Children(props: Walk & { entry: Entry }) {
  const { entry, ...walk } = props
  const listing = useQuery({ ...dirsQuery(walk.machine, entry.path), enabled: true })
  if (listing.isPending) {
    return (
      <div aria-busy="true" className="ns__sub">
        <Skeleton />
      </div>
    )
  }
  if (listing.error) {
    const said = asApiError(listing.error).status === 409 ? 'not a directory' : `${walk.machine} could not be asked`
    return <div className="ns__sub">{note(said)}</div>
  }
  if (!listing.data.access) return <div className="ns__sub">{note(noAccess(walk.machine))}</div>
  const shown = listing.data.entries.filter((one) => one.kind === 'dir' && (walk.hidden || !one.name.startsWith('.')))
  return (
    <ul aria-label={`Folders in ${entry.name}`} className="ns__list ns__sub">
      {shown.length === 0 ? <li>{note('no folders here')}</li> : null}
      <FolderTree entries={shown} {...walk} />
    </ul>
  )
}

/** A folder that can be entered is a button, and a second button opens its
 *  subfolders in place. A closed folder and a file are drawn and marked, and
 *  nothing happens when one is pressed (Y-414). */
function Node(props: Walk & { entry: Entry }) {
  const { entry, ...walk } = props
  const [open, setOpen] = useState(false)
  if (entry.kind === 'file') {
    return (
      <div className="ns__node">
        <span className="ns__toggle" />
        <Row className="ns__inert" tone="plain">
          <Lead>
            <File />
          </Lead>
          <RowText headline={entry.name} supporting="file" />
        </Row>
      </div>
    )
  }
  if (!entry.access) {
    return (
      <div className="ns__node">
        <span className="ns__toggle" />
        <Row className="ns__inert" tone="plain">
          <Lead tone="error">
            <FolderLock />
          </Lead>
          <RowText headline={entry.name} supporting="no access" />
        </Row>
      </div>
    )
  }
  return (
    <>
      <div className="ns__node">
        <button
          aria-expanded={open}
          aria-label={`Show folders in ${entry.name}`}
          className="ns__toggle m3-interactive"
          onClick={() => setOpen(!open)}
          type="button"
        >
          <ChevronRight aria-hidden="true" />
        </button>
        <Row onClick={() => walk.onWalk(entry)} render={<button type="button" />}>
          <Lead tone={entry.repo ? 'primary' : undefined}>{entry.repo ? <FolderGit2 /> : <Folder />}</Lead>
          <RowText headline={entry.name} supporting={badge(entry)} />
        </Row>
      </div>
      {open ? <Children entry={entry} {...walk} /> : null}
    </>
  )
}

/** List items for a folder's entries; the caller owns the `<ul>`. */
export function FolderTree(props: Walk & { entries: Entry[] }) {
  const { entries, ...walk } = props
  return entries.map((entry) => (
    <li key={entry.path}>
      <Node entry={entry} {...walk} />
    </li>
  ))
}
