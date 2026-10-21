/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ContextWindowMeter.tsx,
 * ContextWindowMeter.logic.ts and lib/contextWindow.ts, without the compaction and the cost:
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ContextWindowMeter.logic.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */

export type Usage = { used: number; max: number }

/** Above this share the ring turns to the error colour. */
export const OVERLOADED = 90

/** From this share the ring carries its number: a phone has no hover to show it. */
export const LABELLED = 70

export function usedShare(usage: Usage): number {
  if (usage.max <= 0) return 0
  return Math.max(0, Math.min(100, (usage.used / usage.max) * 100))
}

export function isOverloaded(usage: Usage): boolean {
  return usedShare(usage) > OVERLOADED
}

export function formatPercentage(value: number): string {
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(value)}%`
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (value < 1_000) return `${Math.round(value)}`
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (value < 999_500) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}
