import { describe, expect, it } from 'vitest'
import { stripControls } from './controls'

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, at) => from + at)

describe('stripControls', () => {
  it.each([...range(0x00, 0x1f).filter((code) => code !== 0x09 && code !== 0x0a), 0x7f, ...range(0x80, 0x9f)])(
    'removes code point %i',
    (code) => {
      expect(stripControls(`a${String.fromCodePoint(code)}b`)).toBe('ab')
    },
  )

  it('keeps tab, newline, text outside ASCII and a joined emoji', () => {
    const text = 'if x:\n\treturn "नमस्ते é 👩‍💻"'
    expect(stripControls(text)).toBe(text)
  })

  it('removes the characters that end a bracketed paste early', () => {
    expect(stripControls("sudo apt update\u001b[201~\rsudo sh -c 'x'\r")).toBe("sudo apt update[201~sudo sh -c 'x'")
  })
})
