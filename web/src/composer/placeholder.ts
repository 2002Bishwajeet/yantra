/*
 * The placeholder states are cut from T3 Code's at 810e8f6, apps/web/src/composerPlaceholder.ts
 * and the prompt placeholder of apps/web/src/components/chat/ChatComposer.tsx:
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/composerPlaceholder.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */

/** The words an empty composer shows, in each state Yantra has. */
export function placeholder(state: {
  link: 'connecting' | 'open' | 'closed'
  waiting: boolean
  agent: string
  /** Whether the error above draws a Try again button. */
  retryable?: boolean
}): string {
  if (state.link === 'closed') return state.retryable ? 'The chat is closed. Try again above.' : 'The chat is closed.'
  if (state.link === 'connecting') return 'Connecting to the chat…'
  if (state.waiting) return `${state.agent} is waiting for your answer above`
  return 'Ask for changes or attach images'
}
