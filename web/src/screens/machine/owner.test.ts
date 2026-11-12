import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminProblem, rememberAdmin, rememberedAdmin } from './owner'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the admin account name', () => {
  it('takes what the daemon takes', () => {
    for (const name of ['biswa', 'bishwajeet.p', 'ci_runner-2', 'Admin', 'a'.repeat(32)]) {
      expect(adminProblem(name), name).toBeNull()
    }
  })

  it('refuses what the daemon refuses, and says which rule', () => {
    expect(adminProblem('')).toBe('empty')
    expect(adminProblem('a'.repeat(33))).toBe('long')
    expect(adminProblem('-x')).toBe('lead')
    expect(adminProblem('.hidden')).toBe('lead')
    expect(adminProblem('a b')).toBe('char')
    expect(adminProblem('%h')).toBe('char')
    expect(adminProblem('root@pi')).toBe('char')
  })
})

describe('the remembered name', () => {
  it('is kept per machine, and an empty name forgets it', () => {
    rememberAdmin('pi', 'biswa')
    rememberAdmin('mac', 'bishwajeet')
    expect(rememberedAdmin('pi')).toBe('biswa')
    expect(rememberedAdmin('mac')).toBe('bishwajeet')
    rememberAdmin('pi', '')
    expect(rememberedAdmin('pi')).toBe('')
    expect(localStorage.getItem('yantra.owner.pi')).toBeNull()
  })

  it('is empty, and never thrown, where the browser refuses storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'QuotaExceededError')
    })
    expect(() => rememberAdmin('pi', 'biswa')).not.toThrow()
    expect(rememberedAdmin('pi')).toBe('')
  })
})
