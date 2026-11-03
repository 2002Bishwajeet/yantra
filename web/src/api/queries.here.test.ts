import { describe, expect, it } from 'vitest'
import type { Query } from '@tanstack/react-query'
import type { Here } from '@/api'
import { hereQuery } from './queries'

type HereKey = readonly ['here']

const interval = (data: Here | undefined) => {
  const every = hereQuery().refetchInterval
  if (typeof every !== 'function') throw new Error('refetchInterval is a function')
  return every({ state: { data } } as unknown as Query<Here, Error, Here, HereKey>)
}

describe('hereQuery', () => {
  it('asks again while the device is unnamed, failed or not yet listed', () => {
    expect(interval(undefined)).toBeGreaterThan(0)
    expect(interval({ machine: null })).toBeGreaterThan(0)
  })

  it('stops once the device is named', () => {
    expect(interval({ machine: 'laptop' })).toBe(false)
  })
})
