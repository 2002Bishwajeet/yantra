import { describe, expect, it } from 'vitest'
import { placeholder } from './placeholder'

const base = { waiting: false, agent: 'Claude' }

describe('the placeholder', () => {
  it('words each state', () => {
    expect(placeholder({ ...base, link: 'connecting' })).toBe('Connecting to the chat…')
    expect(placeholder({ ...base, link: 'open' })).toBe('Ask for changes or attach images')
    expect(placeholder({ ...base, link: 'open', waiting: true })).toBe('Claude is waiting for your answer above')
  })

  it('sends a retryable close to the button above', () => {
    expect(placeholder({ ...base, link: 'closed', retryable: true })).toBe('The chat is closed. Try again above.')
  })

  it('does not send a close that has no button to a button', () => {
    expect(placeholder({ ...base, link: 'closed', retryable: false })).toBe('The chat is closed.')
    expect(placeholder({ ...base, link: 'closed' })).toBe('The chat is closed.')
  })
})
