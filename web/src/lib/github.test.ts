import { describe, expect, it } from 'vitest'
import * as contract from '@/contract.gen'
import type { Check } from '@/api'
import type { Reading } from '@/api/client'
import { grant, grantPage, held, hiddenNote, signedIn } from './github'

const checked = (state: Check['state']): Reading<Check> => ({
  looked: 'ok',
  age_seconds: 0,
  data: { ...contract.githubReadiness.data, state },
})

describe('grant', () => {
  it('is asking until the daemon answers', () => {
    expect(grant(undefined, { looked: 'pending' })).toEqual({ kind: 'asking' })
  })

  it('is none or pending without a held grant', () => {
    expect(grant(contract.disconnected, checked('absent'))).toEqual({ kind: 'none' })
    expect(grant({ ...contract.disconnected, pending: true }, { looked: 'pending' })).toEqual({ kind: 'pending' })
  })

  it('is accepted when GitHub accepts the grant', () => {
    expect(grant(contract.github, contract.githubReadiness)).toEqual({ kind: 'accepted', login: '2002Bishwajeet' })
  })

  it('is refused when the daemon holds a grant GitHub refused', () => {
    expect(grant(contract.github, contract.githubRefused)).toEqual({ kind: 'refused', login: '2002Bishwajeet' })
    expect(grant({ ...contract.github, login: null }, contract.githubRefused)).toEqual({ kind: 'refused', login: null })
  })

  it('is unasked when GitHub could not be asked', () => {
    const unasked = { kind: 'unasked', login: '2002Bishwajeet' }
    expect(grant(contract.github, checked('unknown'))).toEqual(unasked)
    expect(grant(contract.github, { looked: 'never' })).toEqual(unasked)
    expect(grant(contract.github, { looked: 'pending' })).toEqual(unasked)
  })

  it('is unasked when the readiness fetch failed', () => {
    expect(grant({ ...contract.github, login: null }, { looked: 'failed', age_seconds: 0, error: 'HTTP 500' })).toEqual({
      kind: 'unasked',
      login: null,
    })
  })
})

describe('words', () => {
  it('never says someone', () => {
    const all = [
      held({ kind: 'accepted', login: null }, false),
      held({ kind: 'unasked', login: null }, true),
      held({ kind: 'refused', login: null }, false),
      signedIn(null),
    ]
    for (const words of all) expect(words).not.toContain('someone')
  })

  it('keeps the string the baselines show when the login is known', () => {
    expect(held({ kind: 'accepted', login: 'ada' }, false)).toBe('signed in as ada · repositories, reviews, issues')
    expect(held({ kind: 'accepted', login: 'ada' }, true)).toBe('Connected as ada')
  })

  it('says GitHub was not asked when the login is unread', () => {
    expect(held({ kind: 'unasked', login: null }, false)).toBe('Signed in · GitHub not asked yet')
    expect(held({ kind: 'refused', login: null }, false)).toBe('GitHub refused the grant')
  })

  it('names the login only when it is known', () => {
    expect(signedIn('ada')).toBe('Signed in as ada')
    expect(signedIn(null)).toBe('Signed in')
  })
})

describe('grantPage', () => {
  it("is the app's own page with a client id, and every app's without", () => {
    expect(grantPage('Iv1.abc')).toBe('https://github.com/settings/connections/applications/Iv1.abc')
    expect(grantPage(null)).toBe('https://github.com/settings/applications')
    expect(grantPage('')).toBe('https://github.com/settings/applications')
  })
})

describe('hiddenNote', () => {
  it('says a private membership is not listed, and names the organisations it sees none from', () => {
    expect(hiddenNote(['a', 'b'])).toBe('A private membership is not listed. No repository from a, b.')
    expect(hiddenNote([])).toBe('A private membership is not listed.')
  })
})
