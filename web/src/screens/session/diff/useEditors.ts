import { useEffect, useRef } from 'react'
import { asApiError } from '@/api/errors'
import { useThreads } from '@/api/mutations'
import { DiffError } from './errors'

export type Editors = {
  /** Null while the thread list is read, or when it failed. */
  worktree: string | null
  trouble: DiffError | null
  /** Left out when asking again cannot help: the chat has no thread yet. */
  retry?: () => void
}

/** The thread's worktree, which the editor links name. The list is asked once
 *  `wanted`, and again when the chat's thread is named. */
export function useEditors(workspace: string, thread: string | null, wanted: boolean): Editors {
  const threads = useThreads(workspace)
  const { mutate } = threads
  const asked = useRef('')
  useEffect(() => {
    const key = `${workspace}/${thread}`
    if (!wanted || thread === null || asked.current === key) return
    asked.current = key
    mutate()
  }, [workspace, thread, wanted, mutate])

  if (thread === null) return { worktree: null, trouble: new DiffError('threadsFailed', 'this chat has no thread yet') }
  const found = threads.data?.find((one) => one.id === thread)
  const retry = () => mutate()
  if (threads.isError) {
    return { worktree: null, trouble: new DiffError('threadsFailed', asApiError(threads.error).said), retry }
  }
  if (threads.isSuccess && found === undefined) {
    return { worktree: null, trouble: new DiffError('threadsFailed', `this workspace lists no thread ${thread}`), retry }
  }
  return { worktree: found?.worktree ?? null, trouble: null }
}
