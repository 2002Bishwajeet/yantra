import { describe, expect, it } from 'vitest'
import { asView, VIEWS } from './views'

describe('asView', () => {
  it('holds three views, with the transcript no longer one of them', () => {
    expect(VIEWS).toEqual(['chat', 'terminal', 'spend'])
  })

  it.each(['chat', 'terminal', 'spend'])('keeps %s', (view) => expect(asView(view)).toBe(view))

  it('sends an old transcript link to the terminal that holds it now', () => {
    expect(asView('transcript')).toBe('terminal')
  })

  it.each(['bogus', '', undefined, 3])('drops %j', (given) => expect(asView(given)).toBeUndefined())
})
