/*
 * The tree is T3 Code's diff file tree cut down: Pierre's tree on the changed
 * paths, git status colours, and a selection that reveals its row:
 * https://github.com/pingdotgg/t3code/blob/1451e7c/apps/web/src/components/diffs/DiffFileTree.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useEffect, useRef } from 'react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { ancestors, decoration, type TreeEntry } from './tree'

export type DiffTreeProps = {
  entries: readonly TreeEntry[]
  selected: string | null
  /** Called again for a click on the row already selected: the reader may have scrolled away. */
  onSelect: (path: string) => void
}

export function DiffTree(props: DiffTreeProps) {
  const { entries, selected, onSelect } = props
  const paths = entries.map((entry) => entry.path)
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  // The tree keeps the first callbacks it was given, so they read the latest through this.
  const latest = useRef({ known: byPath, onSelect })
  useEffect(() => {
    latest.current = { known: byPath, onSelect }
  })
  const syncing = useRef(false)
  const pick = (path: string) => {
    if (latest.current.known.has(path)) latest.current.onSelect(path)
  }

  const { model } = useFileTree({
    density: 'compact',
    flattenEmptyDirectories: true,
    initialExpansion: 'open',
    paths,
    gitStatus: entries.map((entry) => ({ path: entry.path, status: entry.status })),
    search: false,
    onSelectionChange: (chosen) => {
      const path = chosen.at(-1)
      if (!syncing.current && path !== undefined) pick(path)
    },
    renderRowDecoration: ({ item }) => {
      const entry = latest.current.known.get(item.path)
      return entry ? decoration(entry) : null
    },
  })

  const key = paths.join('\n')
  const mounted = useRef(key)
  useEffect(() => {
    if (mounted.current === key) return
    mounted.current = key
    model.resetPaths(paths)
    model.setGitStatus(entries.map((entry) => ({ path: entry.path, status: entry.status })))
  }, [model, key, paths, entries])

  useEffect(() => {
    if (selected === null) return
    const item = model.getItem(selected)
    if (item === null || item.isDirectory()) return
    syncing.current = true
    for (const path of model.getSelectedPaths()) if (path !== selected) model.getItem(path)?.deselect()
    for (const folder of ancestors(selected)) {
      const directory = model.getItem(folder)
      if (directory !== null && 'expand' in directory) directory.expand()
    }
    item.select()
    model.scrollToPath(selected, { offset: 'nearest' })
    queueMicrotask(() => {
      syncing.current = false
    })
  }, [model, selected, key])

  return (
    <FileTree
      aria-label="Changed files"
      className="diff__tree"
      model={model}
      onClickCapture={(event) => {
        const row = event.nativeEvent
          .composedPath()
          .find((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-item-path'))
        const path = row?.getAttribute('data-item-path')
        if (path) pick(path)
      }}
    />
  )
}
