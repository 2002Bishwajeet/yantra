import type { ChangedFile, ChatBranchDiff } from '@/api/thread'

/** What the viewer draws. A turn's diff has no file list: it is read from the patch. */
export type DiffData = {
  unified: string
  files?: ChangedFile[]
  truncated: boolean
  filesTruncated: boolean
}

export const branchData = (diff: ChatBranchDiff): DiffData => ({
  unified: diff.unifiedDiff,
  files: diff.files,
  truncated: diff.truncated,
  filesTruncated: diff.filesTruncated,
})

/** The panel's state: asked for, failed, or in hand. */
export type DiffState =
  | { state: 'loading' }
  | { state: 'failed'; error: import('./errors').DiffError }
  | { state: 'ready'; data: DiffData }
