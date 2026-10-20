/*
 * The tree's rows and status are adapted from T3 Code's diff file tree logic:
 * https://github.com/pingdotgg/t3code/blob/1451e7c/apps/web/src/components/diffs/diffFileTree.logic.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import type { FileDiffMetadata } from '@pierre/diffs'
import type { GitStatus } from '@pierre/trees'
import type { ChangedFile } from '@/api/thread'

export type TreeEntry = {
  path: string
  from?: string
  added?: number
  deleted?: number
  binary: boolean
  status: GitStatus
}

type Types = ReadonlyMap<string, FileDiffMetadata['type']>

function statusOf(file: ChangedFile, types: Types | undefined): GitStatus {
  switch (types?.get(file.path)) {
    case 'new':
      return 'added'
    case 'deleted':
      return 'deleted'
    case 'rename-pure':
    case 'rename-changed':
      return 'renamed'
    default:
      return file.from === undefined ? 'modified' : 'renamed'
  }
}

/** One row per changed file. No counts is a binary file (the daemon's rule). */
export function treeEntries(files: readonly ChangedFile[], types?: Types): TreeEntry[] {
  return files.map((file) => ({
    path: file.path,
    ...(file.from === undefined ? {} : { from: file.from }),
    ...(file.added === undefined ? {} : { added: file.added }),
    ...(file.deleted === undefined ? {} : { deleted: file.deleted }),
    binary: file.added === undefined && file.deleted === undefined,
    status: statusOf(file, types),
  }))
}

/** The words after a row's name: counts, or "binary", and "renamed" first. */
export function decoration(entry: TreeEntry): { text: string; title: string } {
  const counts = entry.binary ? 'binary' : `+${entry.added ?? 0} −${entry.deleted ?? 0}`
  const renamed = entry.from !== undefined
  return {
    text: renamed ? `renamed ${counts}` : counts,
    title: renamed ? `Renamed from ${entry.from}. ${counts}` : counts,
  }
}

/** Every folder above `path`, shallowest first, each with its trailing slash. */
export function ancestors(path: string): string[] {
  const folders: string[] = []
  let at = ''
  for (const segment of path.split('/').slice(0, -1)) {
    at += `${segment}/`
    folders.push(at)
  }
  return folders
}

/** The paths git calls binary in a patch. A file with no hunks is binary only if git says so:
 *  an empty file or a mode change has none either. */
export function binaryPaths(unified: string): Set<string> {
  const paths = new Set<string>()
  for (const section of unified.split(/^(?=diff --git )/m)) {
    if (!/^(Binary files .* differ|GIT binary patch)$/m.test(section)) continue
    const path = /^diff --git a\/.* b\/(.+)$/m.exec(section)?.[1]
    if (path !== undefined) paths.add(path)
  }
  return paths
}

/** The daemon's list for a turn, which has none: read from the patch itself. */
export function filesOfPatch(parsed: readonly FileDiffMetadata[], binaries: ReadonlySet<string> = new Set()): ChangedFile[] {
  return parsed.map((file) => ({
    path: file.name,
    ...(file.prevName === undefined ? {} : { from: file.prevName }),
    ...(binaries.has(file.name)
      ? {}
      : {
          added: file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
          deleted: file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
        }),
  }))
}
