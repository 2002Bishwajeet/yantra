import { useState } from 'react'
import type { Transcript, Turn } from './api'

/** How many **records** one read asks for — D5 §4.4's window and the daemon's
 *  own default. Records are not turns: fifty of them measured as forty-one
 *  (§2.3), so this page counts records and never promises turns. */
export const LINES = 50

/** What the page holds, and nothing before the first read.
 *
 *  **It lives above the tab.** Only the open tab is mounted (D5 §3.5), and
 *  switching to the terminal and back may not spend a second ssh (§4.3). */
export type Said =
  | { said: 'no' }
  | { said: 'reading' }
  | {
      said: 'held'
      /** From the **first** read. A later one that disagrees is §4.4's moved
       *  ground rather than a newer number to adopt. */
      total: number
      /** Records asked for so far, which is what the count line reports. */
      asked: number
      /** Oldest first. `Older` prepends a disjoint window and stitches
       *  nothing. */
      turns: Turn[]
      at: string
      /** An `Older` read in flight. */
      paging: boolean
      moved: boolean
    }
  | Failed

/** The daemon's 409 — no transcript, or one with no turn in it yet — and every
 *  other way a read does not happen. Neither 409 is a failure, so neither is
 *  drawn as one (D5 §4.5). */
type Failed =
  | { said: 'nothing'; because: string }
  | { said: 'refused'; status: number | null; because: string }

type Answer = { read: Transcript; at: string } | Failed

// Outside the hook for `useLooked`'s reason: the React Compiler bails out of a
// function whose try/catch holds a conditional.
async function ask(
  name: string,
  lines: number,
  before: number,
): Promise<Answer> {
  const path = `/api/workspaces/${encodeURIComponent(name)}/logs`

  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines, before }),
    })
    if (response.status === 409) {
      return { said: 'nothing', because: await response.text() }
    }
    if (!response.ok) {
      return {
        said: 'refused',
        status: response.status,
        because: await response.text(),
      }
    }
    return {
      read: (await response.json()) as Transcript,
      at: new Date().toISOString(),
    }
  } catch (cause) {
    return { said: 'refused', status: null, because: String(cause) }
  }
}

function merge(
  held: Said,
  answer: Answer,
  lines: number,
  before: number,
): Said {
  // One failure path, as `/usage` has: a read that could not be made replaces
  // what is on screen rather than annotating it.
  if (!('read' in answer)) return answer

  const { read, at } = answer
  const asked = Math.min(before + lines, read.total)
  if (before === 0 || held.said !== 'held') {
    return {
      said: 'held',
      total: read.total,
      asked,
      turns: read.turns,
      at,
      paging: false,
      moved: false,
    }
  }

  // D5 §4.4: the ground moved. The window is counted from the end of a file
  // that has grown, so it no longer lines up with what is drawn — and a reader
  // could never detect the overlap or the gap that stitching would produce.
  if (read.total > held.total) return { ...held, paging: false, moved: true }

  return {
    ...held,
    // The windows are disjoint, so this prepends and stitches nothing. `at`
    // stays the newest read's: an older window says nothing about how fresh
    // the newest turn on the page is.
    turns: [...read.turns, ...held.turns],
    asked,
    paging: false,
  }
}

/** The transcript of one workspace, read on request (D5 §4.3). Called by the
 *  page rather than by the tab, so the answer outlives a switch to the
 *  terminal; nothing is fetched until `read` is called. */
export function useTranscript(name: string) {
  const [said, setSaid] = useState<Said>({ said: 'no' })

  const read = async (lines: number, before: number) => {
    setSaid((held) =>
      before === 0
        ? { said: 'reading' }
        : held.said === 'held'
          ? { ...held, paging: true }
          : held,
    )
    const answer = await ask(name, lines, before)
    setSaid((held) => merge(held, answer, lines, before))
  }

  return { said, read }
}
