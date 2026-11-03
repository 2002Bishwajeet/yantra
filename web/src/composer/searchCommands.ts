/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/composerSlashCommandSearch.ts
 * and packages/shared/src/searchRanking.ts (scoreQueryMatch, scoreSubsequenceMatch):
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/composerSlashCommandSearch.ts
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/packages/shared/src/searchRanking.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import type { SlashCommand } from '@/api'

type Bases = { exact: number; prefix: number; boundary: number; includes: number; fuzzy?: number; markers: string[] }

const NAME: Bases = { exact: 0, prefix: 2, boundary: 4, includes: 6, fuzzy: 100, markers: ['-', '_', '/'] }
const DESCRIPTION: Bases = { exact: 20, prefix: 22, boundary: 24, includes: 26, markers: [' ', '-', '_', '/'] }

function subsequence(value: string, query: string): number | null {
  let at = 0
  let first = -1
  let previous = -1
  let gaps = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== query[at]) continue
    if (first === -1) first = index
    if (previous !== -1) gaps += index - previous - 1
    previous = index
    at += 1
    if (at === query.length) {
      const span = index - first + 1 - query.length
      return first * 2 + gaps * 3 + span + Math.min(64, value.length - query.length)
    }
  }
  return null
}

/** Lower is better; `null` does not match. */
function score(value: string, query: string, bases: Bases): number | null {
  if (!value) return null
  if (value === query) return bases.exact
  const penalty = Math.min(64, Math.max(0, value.length - query.length))
  if (value.startsWith(query)) return bases.prefix + penalty
  const boundaries = bases.markers
    .map((marker) => value.indexOf(`${marker}${query}`))
    .filter((index) => index !== -1)
    .map((index) => index + 1)
  if (boundaries.length > 0) return bases.boundary + Math.min(...boundaries) * 2 + penalty
  const inside = value.indexOf(query)
  if (inside !== -1) return bases.includes + inside * 2 + penalty
  if (bases.fuzzy === undefined) return null
  const fuzzy = subsequence(value, query)
  return fuzzy === null ? null : bases.fuzzy + fuzzy
}

/** The commands that match `query` (typed after `/`), best first, ties by name. All of them when nothing is typed. */
export function searchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const wanted = query.trim().replace(/^\/+/, '').toLowerCase()
  if (!wanted) return [...commands]
  return commands
    .flatMap((command) => {
      const scores = [
        score(command.name.toLowerCase(), wanted, NAME),
        score(command.description.toLowerCase(), wanted, DESCRIPTION),
      ].filter((one): one is number => one !== null)
      return scores.length > 0 ? [{ command, rank: Math.min(...scores) }] : []
    })
    .sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name))
    .map((entry) => entry.command)
}
