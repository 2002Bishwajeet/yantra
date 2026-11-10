import { afterEach, describe, expect, it } from 'vitest'
import { KEYS, SHELL_KEYS, matchChord, matchHelp } from './keys'

afterEach(() => {
  document.body.innerHTML = ''
})

const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
const chordOf = (id: string) => {
  const one = KEYS.find((key) => key.id === id)!
  return { code: one.code, altKey: one.alt, ctrlKey: true }
}

describe('the loop chords', () => {
  it('has one chord for each of the six verbs', () => {
    expect(KEYS.map((one) => one.id).sort()).toEqual(['commit', 'diff', 'issue', 'merge', 'pr', 'push'])
    expect(new Set(KEYS.map((one) => one.id)).size).toBe(KEYS.length)
  })

  it('has no two chords alike, and none is the palette or a chord Chrome keeps', () => {
    const shape = KEYS.map((one) => `${one.code}|${one.alt}`)
    expect(new Set(shape).size).toBe(KEYS.length)
    expect(KEYS.some((one) => one.code === 'KeyK' && !one.alt)).toBe(false)
    // Chrome keeps Ctrl+Shift+I, C and J; no chord of ours uses Shift.
    expect(matchChord(press({ ...chordOf('commit'), shiftKey: true }))).toBeNull()
  })

  it.each(KEYS.map((one) => [one.id]))('matches %s by its code, so a Mac Option chord still does', (id) => {
    expect(matchChord(press({ ...chordOf(id), key: 'ç' }))).toBe(id)
    expect(matchChord(press({ ...chordOf(id), metaKey: true, ctrlKey: false }))).toBe(id)
  })

  it('needs the modifier, and the same Alt state as the chord', () => {
    expect(matchChord(press({ code: 'KeyC', altKey: true }))).toBeNull()
    expect(matchChord(press({ code: 'KeyC', ctrlKey: true }))).toBeNull()
    expect(matchChord(press({ code: 'KeyD', ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('is skipped in the terminal, and still matches in a text field because it has a modifier', () => {
    document.body.innerHTML = '<div class="xterm"><textarea id="t"></textarea></div><textarea id="c"></textarea>'
    document.getElementById('t')!.focus()
    expect(matchChord(press(chordOf('push')))).toBeNull()
    document.getElementById('c')!.focus()
    expect(matchChord(press(chordOf('push')))).toBe('push')
  })

  it('draws a display string for each, and the shell keys are not among them', () => {
    expect(KEYS.every((one) => one.display.length > 0)).toBe(true)
    expect(SHELL_KEYS.map((one) => one.display)).toContain('?')
  })
})

describe('the ? key', () => {
  it('opens help when focus is on the page', () => {
    expect(matchHelp(press({ key: '?', shiftKey: true }))).toBe(true)
    expect(matchHelp(press({ key: '/' }))).toBe(false)
    expect(matchHelp(press({ key: '?', ctrlKey: true }))).toBe(false)
  })

  it.each([['<textarea id="f"></textarea>'], ['<input id="f">'], ['<div class="xterm"><span id="f" tabindex="0"></span></div>']])(
    'is skipped in %s',
    (html) => {
      document.body.innerHTML = html
      document.getElementById('f')!.focus()
      expect(matchHelp(press({ key: '?' }))).toBe(false)
    },
  )
})
