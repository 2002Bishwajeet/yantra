import { useEffect, useRef, useState } from 'react'
import type { ApiError } from '@/api/errors'
import { attachTerminal, type Link, type Target, terminalAddress } from '@/api/socket'

/** What Claude's own dialog is asking, read off the pane. The options are the
 *  agent's words and numbers; Yantra draws them and sends the number back
 *  (D5 §5.2, the `y332-chat` note). */
export type Prompt = {
  /** The dialog's heading, "Bash command". */
  kind: string | null
  /** The first content line under it: the command, the path. */
  subject: string | null
  question: string
  options: { number: string; label: string }[]
}

/** tmux redraws the pane with cursor moves rather than newlines, so a move to
 *  a row is a line break before every other escape is dropped. */
const ESC = '\u001b'
const BEL = '\u0007'
const MOVES = new RegExp(`${ESC}\\[\\d*;?\\d*[Hf]`, 'g')
const ESCAPES = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[()][A-Za-z0-9]|${ESC}[=>78]`,
  'g',
)
const BOX = /^[│┃|]\s?|\s?[│┃|]$/g
const OPTION = /^\s*[>❯]?\s*(\d)\.\s+(.*?)\s*(?:\(esc\))?\s*$/
const QUESTION = /\?\s*$/

export function plain(bytes: string): string {
  return bytes.replace(MOVES, '\n').replace(ESCAPES, '').replace(/\r/g, '')
}

/** The last dialog on the screen, or null. A dialog is a question ending in
 *  `?` followed by numbered options; the heading and subject are the box's
 *  first two lines when there is a box. */
export function parsePrompt(text: string): Prompt | null {
  const lines = plain(text)
    .split('\n')
    .map((line) => line.replace(BOX, '').trimEnd())
  let question = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION.test(lines[i]) && OPTION.test(lines[i + 1] ?? '')) {
      question = i
      break
    }
  }
  if (question < 0) return null

  const options: Prompt['options'] = []
  for (let i = question + 1; i < lines.length; i++) {
    const hit = OPTION.exec(lines[i])
    if (!hit) {
      if (lines[i].trim() === '' && options.length === 0) continue
      break
    }
    options.push({ number: hit[1], label: hit[2] })
  }
  if (options.length === 0) return null

  // Walk up to the box's top edge for the heading and the subject.
  let top = question
  while (top > 0 && !/^[╭┌]/.test(lines[top - 1]) && question - top < 12) top--
  const inside = lines.slice(top, question).filter((line) => line.trim() !== '')
  return {
    kind: inside[0]?.trim() ?? null,
    subject: inside[1]?.trim() ?? null,
    question: lines[question].trim(),
    options,
  }
}

/** How much of the pane is kept for parsing; a dialog is a few hundred bytes. */
const KEEP = 16_384

export type Pane = {
  link: Link
  refused: ApiError | null
  /** The budget spent, or the socket closed for good. */
  over: boolean
  prompt: Prompt | null
  /** Text and Enter, as the composer sends it. */
  type: (text: string) => void
}

/** The workspace's terminal socket without a screen: the chat composer's way
 *  into the pane, and where the trust prompt is read from. A fixed window,
 *  since nothing is drawn — wide enough that the dialog's lines do not wrap.
 *  Key the caller on the target: a new socket starts from a clean state. */
/** `again` counts a person's Try again: a change reopens the socket. */
export function usePane(target: Target, again = 0): Pane {
  const url = terminalAddress(target)
  const [link, setLink] = useState<Link>({ up: false, attempt: 0 })
  // Stamped with `again`, so a reopened socket starts clean without an
  // effect resetting state.
  const [ended, setEnded] = useState<{ at: number; refused: ApiError | null; over: boolean }>({
    at: -1,
    refused: null,
    over: false,
  })
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const attached = useRef<ReturnType<typeof attachTerminal> | null>(null)
  const seen = useRef('')

  useEffect(() => {
    const bytes = new TextDecoder()
    seen.current = ''
    const live = attachTerminal(url, {
      size: () => ({ rows: 50, cols: 160 }),
      onBytes: (chunk) => {
        seen.current = (seen.current + bytes.decode(chunk, { stream: true })).slice(-KEEP)
        setPrompt(parsePrompt(seen.current))
      },
      onEnd: (why) => setEnded({ at: again, refused: why, over: why === null }),
      onLink: setLink,
    })
    attached.current = live
    return () => {
      attached.current = null
      live.close()
    }
  }, [url, again])

  return {
    link,
    refused: ended.at === again ? ended.refused : null,
    over: ended.at === again && ended.over,
    prompt,
    type: (text) => {
      attached.current?.type(text)
      // The agent redraws after an answer; what was on screen is answered.
      seen.current = ''
      setPrompt(null)
    },
  }
}
