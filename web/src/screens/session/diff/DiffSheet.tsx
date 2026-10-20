import { lazy, Suspense, useState } from 'react'
import { ErrorBoundary as Load } from 'react-error-boundary'
import type { Workspace } from '@/api'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import type { DiffState } from './data'
import { DiffError } from './errors'
import type { Editors } from './useEditors'
import './Diff.css'

// Pierre's diffs, its tree and Shiki are the heaviest code in the dashboard,
// so they arrive with this import and never with `/` or the Chat chunk.
class ChunkError extends Error {}
const load = () =>
  import('./DiffViewer').catch((cause: unknown) => {
    throw new ChunkError(cause instanceof Error ? cause.message : String(cause))
  })

const titles = {
  notOpen: 'The diff could not be asked for',
  noThread: 'There is no branch to compare yet',
  failed: 'The diff could not be read',
  busy: 'The diff waits for the revert',
  threadsFailed: 'Files cannot open in an editor',
  loadFailed: 'The diff viewer did not load',
} as const

function Reading() {
  return (
    <div aria-busy="true" className="diff__reading">
      <Skeleton />
      <Skeleton shape="text" />
      <p className="m3-sr-only" role="status">
        Reading the diff
      </p>
    </div>
  )
}

export type DiffSheetProps = {
  workspace: Workspace
  editors: Editors
  /** A turn's card leaves the editor trouble to the branch panel. */
  quiet?: boolean
  state: DiffState
  /** Asks again. Left out, the panel offers no retry. */
  onRetry?: () => void
  onComment: (block: string) => void
}

/** The panel's frame: what is asked, what failed, and the lazy viewer. */
export function DiffSheet(props: DiffSheetProps) {
  const { workspace, editors, quiet, state, onRetry, onComment } = props
  const [Viewer, setViewer] = useState(() => lazy(load))
  if (state.state === 'loading') return <Reading />
  if (state.state === 'failed') {
    return (
      <ErrorSurface.Inline
        error={state.error}
        eyebrow={`on ${workspace.machine}`}
        reset={onRetry}
        title={titles[state.error.kind]}
      />
    )
  }
  return (
    <ErrorBoundary eyebrow={`on ${workspace.machine}`} layout="inline" resetKeys={[state.data]} title="The diff could not be drawn">
      <Load
        fallbackRender={({ error, resetErrorBoundary }) => {
          // A viewer that throws while it draws is the outer boundary's.
          if (!(error instanceof ChunkError)) throw error
          return (
            <ErrorSurface.Inline
              error={new DiffError('loadFailed', error.message)}
              eyebrow={`on ${workspace.machine}`}
              reset={() => {
                // A failed import is remembered by the module that asked for it.
                setViewer(() => lazy(load))
                resetErrorBoundary()
              }}
              title={titles.loadFailed}
            />
          )
        }}
      >
        <Suspense fallback={<Reading />}>
          <Viewer data={state.data} editors={editors} onComment={onComment} quiet={quiet} workspace={workspace} />
        </Suspense>
      </Load>
    </ErrorBoundary>
  )
}
