/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/composerPromptHistory.ts:
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/composerPromptHistory.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */

export type PromptHistoryEntry = { id: string; prompt: string }
export type PromptHistoryPosition = { entryId: string; recalled: string }
export type PromptHistoryStep = { position: PromptHistoryPosition | null; prompt: string }

/** The daemon puts the path of each attached image on a line of its own after the words. */
const IMAGE_PATH = /^\/\S+\.(?:png|jpe?g|gif|webp)$/i

export function recallablePrompt(text: string): string {
  const lines = text.trim().split('\n')
  while (lines.length > 0 && IMAGE_PATH.test(lines[lines.length - 1]!.trim())) lines.pop()
  return lines.join('\n').trim()
}

export function buildPromptHistoryEntries(
  messages: readonly { id: string; who: string; text: string }[],
): PromptHistoryEntry[] {
  const entries: PromptHistoryEntry[] = []
  for (const message of messages) {
    if (message.who !== 'you') continue
    const prompt = recallablePrompt(message.text)
    if (prompt.length === 0) continue
    const previous = entries[entries.length - 1]
    if (previous && previous.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt }
      continue
    }
    entries.push({ id: message.id, prompt })
  }
  return entries
}

function findActive(entries: readonly PromptHistoryEntry[], position: PromptHistoryPosition): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId)
  if (byId >= 0) return byId
  return entries.findLastIndex((entry) => entry.prompt === position.recalled)
}

/** One step through the earlier prompts. `null` leaves the field alone, as it
 *  does for a draft the person typed, which a recall must not overwrite. */
export function stepPromptHistory(input: {
  direction: 'backward' | 'forward'
  entries: readonly PromptHistoryEntry[]
  position: PromptHistoryPosition | null
  currentPrompt: string
}): PromptHistoryStep | null {
  const { entries, position, currentPrompt } = input
  const activeIndex = position && position.recalled === currentPrompt ? findActive(entries, position) : -1

  if (input.direction === 'backward') {
    if (activeIndex < 0 && currentPrompt.length > 0) return null
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1]
    if (!entry) return null
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt }
  }

  if (activeIndex < 0) return null
  const entry = entries[activeIndex + 1]
  if (!entry) return { position: null, prompt: '' }
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt }
}
