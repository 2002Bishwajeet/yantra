import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepContext, recallContext } from './mode'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the context length a thread keeps', () => {
  it('is recalled for its own thread and no other', () => {
    keepContext('1a2b3c4d', 512_000)
    expect(recallContext('1a2b3c4d')).toBe(512_000)
    expect(recallContext('ffffffff')).toBeNull()
    expect(recallContext(null)).toBeNull()
  })

  it('goes back to the default when Default is kept', () => {
    keepContext('1a2b3c4d', 1_000_000)
    keepContext('1a2b3c4d', null)
    expect(localStorage.getItem('yantra.chat.context.1a2b3c4d')).toBeNull()
    expect(recallContext('1a2b3c4d')).toBeNull()
  })

  it('is the default for a stored value it does not offer', () => {
    for (const kept of ['50000', '2000000', '1m; touch', 'NaN']) {
      localStorage.setItem('yantra.chat.context.1a2b3c4d', kept)
      expect(recallContext('1a2b3c4d')).toBeNull()
    }
  })

  it('is the default when the browser refuses site data', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(() => keepContext('1a2b3c4d', 256_000)).not.toThrow()
    expect(recallContext('1a2b3c4d')).toBeNull()
  })
})
