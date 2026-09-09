import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Reading } from '@/api/hooks'
import { Looked, SinceAgo } from './age'

const NOW = 1_788_683_940_000

describe('SinceAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts with an `ago` behind it', () => {
    render(<SinceAgo at={NOW / 1000 - 3 * 3600} />)
    expect(screen.getByText('3h').parentElement?.textContent).toBe('3h ago')
  })

  it('names the day with nothing behind it', () => {
    render(<SinceAgo at={NOW / 1000 - 4 * 86400} />)
    const day = screen.getByText(/^\d{1,2} \w{3}$/)
    expect(day.parentElement?.textContent).toBe(day.textContent)
  })
})

/** Ledger row 142: `Looked` wrote the word itself, so a page whose oldest read
 *  was days old said *looked 4 Sep ago*. */
describe('Looked', () => {
  const read = (age: number): Reading<unknown>[] => [{ looked: 'ok', age_seconds: age, data: null }]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts with an `ago` behind it', () => {
    render(<Looked reads={read(4)} />)
    expect(screen.getByText('4s').parentElement?.textContent).toBe('looked 4s ago')
  })

  it('names the day with nothing behind it', () => {
    render(<Looked reads={read(7 * 86400)} />)
    const day = screen.getByText(/^\d{1,2} \w{3}$/)
    expect(day.parentElement?.textContent).toBe(`looked ${day.textContent}`)
  })
})
