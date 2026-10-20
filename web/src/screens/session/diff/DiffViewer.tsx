/*
 * The viewer is T3 Code's diff panel cut down to one scroll of files, each
 * with line selection that opens a comment box:
 * https://github.com/pingdotgg/t3code/blob/1451e7c/apps/web/src/components/diffs/AnnotatableCodeView.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getFiletypeFromFileName, parsePatchFiles, type FileDiffMetadata, type SelectedLineRange } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import { MessageSquarePlus } from 'lucide-react'
import type { Workspace } from '@/api'
import { asApiError } from '@/api/errors'
import { threadsQuery } from '@/api/queries'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mono, Text } from '@/m3/text/Text'
import { commentBlock, quotedLines, rangeLabel } from './comment'
import type { DiffData } from './data'
import { DiffComment } from './DiffComment'
import { DiffTree } from './DiffTree'
import { EditorMenu } from './EditorMenu'
import { DiffError } from './errors'
import { knows } from './shiki'
import { filesOfPatch, treeEntries, type TreeEntry } from './tree'

export type DiffViewerProps = {
  workspace: Workspace
  /** The chat's thread, whose worktree the editor links name. */
  thread: string | null
  data: DiffData
  /** Gets the quoted block. The caller puts it in the composer; nothing is sent. */
  onComment: (block: string) => void
}

type Draft = { path: string; range: SelectedLineRange | null }

const THEME = { light: 'pierre-light', dark: 'pierre-dark' } as const

function FileSection(props: {
  entry: TreeEntry
  parsed: FileDiffMetadata | undefined
  draft: Draft | null
  worktree: string | null
  machine: string
  why: string
  heading: (node: HTMLElement | null) => (() => void) | void
  onStart: (draft: Draft) => void
  onCancel: () => void
  onSubmit: (text: string) => void
}) {
  const { entry, parsed, draft, worktree, machine, why, heading, onStart, onCancel, onSubmit } = props
  const id = useId()
  const mine = draft?.path === entry.path ? draft : null
  const first = parsed?.hunks[0]?.additionStart
  const counts = entry.binary ? 'binary' : `+${entry.added ?? 0} −${entry.deleted ?? 0}`
  const empty =
    parsed === undefined
      ? entry.binary
        ? 'A binary file has no lines to show.'
        : 'The diff was cut before this file.'
      : parsed.hunks.length === 0
        ? parsed.type === 'rename-pure'
          ? 'Renamed with no change to its lines.'
          : 'A binary file has no lines to show.'
        : null
  return (
    <section aria-labelledby={id} className="diff__file" data-path={entry.path}>
      <header className="diff__file-head">
        <h3 className="diff__file-name" id={id} ref={heading} tabIndex={-1}>
          <Mono>{entry.path}</Mono>
          {entry.from === undefined ? null : <span className="diff__from">renamed from {entry.from}</span>}
          <span className="diff__counts">{counts}</span>
        </h3>
        <Button
          aria-label={`Comment on file: ${entry.path}`}
          icon={<MessageSquarePlus />}
          onClick={() => onStart({ path: entry.path, range: null })}
          variant="text"
        >
          Comment
        </Button>
        <EditorMenu line={first} machine={machine} path={entry.path} why={why} worktree={worktree} />
      </header>
      {empty !== null ? (
        <Text className="diff__empty" render={<p />} scale="body-medium" tone="variant">
          {empty}
        </Text>
      ) : null}
      {parsed !== undefined && empty === null ? (
        <FileDiff
          fileDiff={parsed}
          lineAnnotations={
            mine
              ? [{ side: mine.range?.endSide ?? mine.range?.side ?? 'additions', lineNumber: mine.range ? Math.max(mine.range.start, mine.range.end) : 0 }]
              : []
          }
          options={{
            theme: THEME,
            themeType: 'system',
            diffStyle: 'unified',
            disableFileHeader: true,
            overflow: 'scroll',
            enableGutterUtility: mine === null,
            enableLineSelection: mine === null,
            onGutterUtilityClick: (range) => onStart({ path: entry.path, range }),
            onLineSelectionEnd: (range) => {
              if (range) onStart({ path: entry.path, range })
            },
          }}
          renderAnnotation={() => (
            <DiffComment
              label={`${entry.path} ${mine?.range ? rangeLabel(mine.range) : 'whole file'}`}
              onCancel={onCancel}
              onSubmit={onSubmit}
            />
          )}
          selectedLines={mine?.range ?? null}
        />
      ) : mine ? (
        <DiffComment label={`${entry.path} whole file`} onCancel={onCancel} onSubmit={onSubmit} />
      ) : null}
    </section>
  )
}

export default function DiffViewer(props: DiffViewerProps) {
  const { workspace, thread, data, onComment } = props
  const parsed = new Map(
    parsePatchFiles(data.unified)
      .flatMap((patch) => patch.files)
      // A grammar the build leaves out would fail the file; text draws it plain.
      .map((file): [string, FileDiffMetadata] => {
        const lang = getFiletypeFromFileName(file.name)
        return [file.name, lang === 'text' || knows(lang) ? file : { ...file, lang: 'text' }]
      }),
  )
  const types = new Map([...parsed].map(([name, file]) => [name, file.type]))
  const entries = treeEntries(data.files ?? filesOfPatch([...parsed.values()]), types)

  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const sections = useRef(new Map<string, HTMLElement>())
  const heads = useRef(new Map<string, HTMLElement>())

  const threads = useQuery({ ...threadsQuery(workspace.name), enabled: thread !== null })
  const found = threads.data?.find((one) => one.id === thread)
  const trouble =
    thread === null
      ? new DiffError('threadsFailed', 'this chat has no thread yet')
      : threads.isError
        ? new DiffError('threadsFailed', asApiError(threads.error).said)
        : threads.isSuccess && found === undefined
          ? new DiffError('threadsFailed', `this workspace lists no thread ${thread}`)
          : null
  const worktree = found?.worktree ?? null
  const why = trouble ? trouble.describe() : 'The editor menu waits for this thread’s worktree.'

  const reveal = (path: string) => {
    setSelected(path)
    sections.current.get(path)?.scrollIntoView?.({ block: 'start' })
  }
  const close = (path: string | undefined) => {
    setDraft(null)
    if (path !== undefined) heads.current.get(path)?.focus()
  }

  return (
    <div className="diff">
      {trouble ? (
        <ErrorSurface.Inline
          error={trouble}
          eyebrow={`on ${workspace.machine}`}
          reset={() => void threads.refetch()}
          title="Files cannot open in an editor"
        />
      ) : null}
      {data.truncated ? (
        <Text render={<p />} scale="body-small" tone="variant">
          Cut at 256 KiB
        </Text>
      ) : null}
      {data.filesTruncated ? (
        <Text render={<p />} scale="body-small" tone="variant">
          The list of files was cut, so some changed files are missing.
        </Text>
      ) : null}
      {entries.length === 0 ? (
        <Text render={<p />} scale="body-medium" tone="variant">
          Nothing has changed on this branch.
        </Text>
      ) : (
        <div className="diff__body">
          <DiffTree entries={entries} onSelect={reveal} selected={selected} />
          <div className="diff__files">
            {entries.map((entry) => (
              <div
                key={entry.path}
                ref={(node) => {
                  if (node) sections.current.set(entry.path, node)
                  return () => void sections.current.delete(entry.path)
                }}
              >
                <FileSection
                  draft={draft}
                  entry={entry}
                  heading={(node) => {
                    if (node) heads.current.set(entry.path, node)
                    return () => void heads.current.delete(entry.path)
                  }}
                  machine={workspace.machine}
                  onCancel={() => close(draft?.path)}
                  onStart={setDraft}
                  onSubmit={(text) => {
                    if (!draft) return
                    const file = parsed.get(draft.path)
                    const lines = file && draft.range ? quotedLines(file, draft.range) : []
                    onComment(commentBlock(draft.path, draft.range, lines, text))
                    close(draft.path)
                  }}
                  parsed={parsed.get(entry.path)}
                  why={why}
                  worktree={worktree}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
