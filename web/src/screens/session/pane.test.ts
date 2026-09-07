import { describe, expect, it } from 'vitest'
import { parsePrompt, plain } from './pane'

/** The box `claude` draws, as `e2e/fixture/server.mjs` sends it — the same
 *  bytes SessionTerminal.dc.html renders. */
const BOX = [
  '● Bash(cargo test -p yantra-core)',
  '  ⎿  Waiting…',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ Bash command                                 │',
  '│                                              │',
  '│   cargo test -p yantra-core                  │',
  "│   Run the core crate's tests                 │",
  '│                                              │',
  '│ Do you want to proceed?                      │',
  '│ > 1. Yes                                     │',
  "│   2. Yes, and don't ask again for cargo test │",
  '│   3. No, and tell Claude what to do (esc)    │',
  '╰──────────────────────────────────────────────╯',
  '',
  '> ',
].join('\r\n')

const ESC = '\u001b'

describe('what the pane says the agent is asking', () => {
  it('reads the heading, the subject and every numbered option out of the box', () => {
    const prompt = parsePrompt(BOX)

    expect(prompt).not.toBeNull()
    expect(prompt?.kind).toBe('Bash command')
    expect(prompt?.subject).toBe('cargo test -p yantra-core')
    expect(prompt?.question).toBe('Do you want to proceed?')
    expect(prompt?.options.map((one) => one.number)).toEqual(['1', '2', '3'])
    // The words are the agent's own; Yantra writes no option of its own
    // (D5 §5.2), and the `(esc)` the dialog prints is not part of one.
    expect(prompt?.options[0]?.label).toBe('Yes')
    expect(prompt?.options[2]?.label).toBe('No, and tell Claude what to do')
  })

  it('finds the box under the escapes tmux redraws a pane with', () => {
    const redrawn = BOX.split('\r\n')
      .map((line, row) => `${ESC}[${row + 1};1H${ESC}[0m${line}`)
      .join('')

    expect(plain(redrawn)).toContain('Do you want to proceed?')
    expect(parsePrompt(redrawn)?.options).toHaveLength(3)
  })

  it('is nothing at all when the pane is only output', () => {
    expect(parsePrompt('● Read(tracker.md)\r\n  ⎿  Read 412 lines\r\n> ')).toBeNull()
    // A question with no numbered answer under it is prose, not a dialog.
    expect(parsePrompt('Shall I go on?\r\n> ')).toBeNull()
  })

  it('takes the last dialog when the pane still holds an answered one', () => {
    const twice = `${BOX}\r\n1\r\n${BOX.replace('Bash command', 'Edit file  ')}`

    expect(parsePrompt(twice)?.kind).toBe('Edit file')
  })
})
