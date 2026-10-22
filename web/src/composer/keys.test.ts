import { describe, expect, it } from 'vitest'
import { composerRequiresModifier, submissionIntentForKey, type KeyLike } from './keys'

const press = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  ...extra,
})
const intent = (event: KeyLike, enterSends: boolean, prompt = 'hello') =>
  submissionIntentForKey({ event, enterSends, prompt })

describe('submissionIntentForKey', () => {
  it('sends on Enter, and writes a new line on Shift+Enter', () => {
    expect(intent(press('Enter'), true)).toBe('send')
    expect(intent(press('Enter', { shiftKey: true }), true)).toBeNull()
  })

  it('needs Mod+Enter when Enter does not send', () => {
    expect(intent(press('Enter'), false)).toBeNull()
    expect(intent(press('Enter', { ctrlKey: true }), false)).toBe('send')
    expect(intent(press('Enter', { metaKey: true }), false)).toBe('send')
  })

  it('needs Mod+Enter inside an open code fence or a list, even when Enter sends', () => {
    expect(intent(press('Enter'), true, 'run:\n```sh\ncargo test')).toBeNull()
    expect(intent(press('Enter', { ctrlKey: true }), true, 'run:\n```sh\ncargo test')).toBe('send')
    expect(intent(press('Enter'), true, 'steps\n- one\n- two')).toBeNull()
    expect(intent(press('Enter'), true, '1. one\n2. two')).toBeNull()
    expect(intent(press('Enter'), true, 'run:\n```sh\ncargo test\n```')).toBe('send')
  })

  it('never sends while an input method composes, or on a held key', () => {
    expect(intent(press('Enter', { isComposing: true }), true)).toBeNull()
    expect(intent(press('Enter', { keyCode: 229 }), true)).toBeNull()
    expect(intent(press('Enter', { repeat: true }), true)).toBeNull()
  })

  it('leaves every other key to the field', () => {
    expect(intent(press('a'), true)).toBeNull()
    expect(intent(press('Enter', { altKey: true }), true)).toBeNull()
  })
})

describe('composerRequiresModifier', () => {
  it('is true when Enter does not send, and for no other plain prompt', () => {
    expect(composerRequiresModifier(false, 'hello')).toBe(true)
    expect(composerRequiresModifier(true, 'hello')).toBe(false)
    expect(composerRequiresModifier(true, '')).toBe(false)
  })
})
