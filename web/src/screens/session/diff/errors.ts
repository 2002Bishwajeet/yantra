/** Every way the diff panel can fail, each from a different place (Y-491). */
export type DiffErrorKind =
  // The chat socket is not open, so the diff could not be asked for.
  | 'notOpen'
  // The chat has no thread yet; the first turn names one.
  | 'noThread'
  // The daemon's `error` frame for a diff: git could not read the branch.
  | 'failed'
  // The thread list failed, so the editor links have no worktree to name.
  | 'threadsFailed'
  // The panel's lazy chunk did not load.
  | 'loadFailed'

const sentences: Record<DiffErrorKind, string> = {
  notOpen: 'The chat is not connected, so the diff could not be asked for.',
  noThread: 'This chat has no branch yet. Send a first message, then open the diff.',
  failed: "git on the workspace's machine could not read this branch's changes.",
  threadsFailed: 'The daemon could not list this workspace’s threads, so files cannot open in an editor.',
  loadFailed: 'The diff viewer did not load. The network may have dropped.',
}

/** The one error the diff panel reports. `said` is the daemon's words, verbatim. */
export class DiffError extends Error {
  readonly kind: DiffErrorKind
  readonly said: string
  readonly retryable: boolean

  constructor(kind: DiffErrorKind, said = '') {
    super(said || sentences[kind])
    this.name = 'DiffError'
    this.kind = kind
    this.said = said
    // A thread the chat has not made does not appear by asking again.
    this.retryable = kind !== 'noThread'
  }

  describe(): string {
    return sentences[this.kind]
  }
}
