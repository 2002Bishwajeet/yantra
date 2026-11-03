import { describe, expect, it } from 'vitest'
import { detectTrigger, insertMention } from './trigger'

describe('detectTrigger', () => {
  it('opens on @ and $ at the start or after whitespace', () => {
    expect(detectTrigger('@src', 4)).toEqual({ kind: 'path', query: 'src', start: 0, end: 4 })
    expect(detectTrigger('fix $rev', 8)).toEqual({ kind: 'skill', query: 'rev', start: 4, end: 8 })
    expect(detectTrigger('a\n@', 3)).toEqual({ kind: 'path', query: '', start: 2, end: 3 })
  })

  it('stays shut inside a word, after a space, and with no trigger', () => {
    expect(detectTrigger('me@host', 7)).toBeNull()
    expect(detectTrigger('cost$5', 6)).toBeNull()
    expect(detectTrigger('@src ', 5)).toBeNull()
    expect(detectTrigger('plain', 5)).toBeNull()
    expect(detectTrigger('', 0)).toBeNull()
  })

  it('reads only up to the caret', () => {
    expect(detectTrigger('@src/main.rs', 4)).toEqual({ kind: 'path', query: 'src', start: 0, end: 4 })
    expect(detectTrigger('@a', 99)?.query).toBe('a')
  })
})

describe('insertMention', () => {
  it('replaces the trigger with the token and a space, and puts the caret after it', () => {
    expect(insertMention('see @ma now', { start: 4, end: 7 }, '@src/main.rs')).toEqual({
      text: 'see @src/main.rs  now',
      caret: 17,
    })
    expect(insertMention('$', { start: 0, end: 1 }, '$review')).toEqual({ text: '$review ', caret: 8 })
  })
})
