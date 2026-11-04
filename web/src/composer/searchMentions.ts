/** At most this many rows: a person types more of the name rather than scroll. */
export const SHOWN = 50

function isSubsequence(query: string, text: string): boolean {
  let at = 0
  for (const char of text) if (char === query[at]) at += 1
  return at === query.length
}

/** 0 when the last segment starts with the query, 1 for a substring, 2 for the letters in order. */
function rank(name: string, query: string): number | null {
  const lower = name.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (base.startsWith(query)) return 0
  if (lower.includes(query)) return 1
  return isSubsequence(query, lower) ? 2 : null
}

/** The entries that match, best first, each tier in the order given. */
export function searchMentions<T>(entries: readonly T[], query: string, name: (entry: T) => string): T[] {
  const wanted = query.toLowerCase()
  if (wanted === '') return entries.slice(0, SHOWN)
  const tiers: T[][] = [[], [], []]
  for (const entry of entries) {
    const tier = rank(name(entry), wanted)
    if (tier !== null) tiers[tier]?.push(entry)
  }
  return tiers.flat().slice(0, SHOWN)
}
