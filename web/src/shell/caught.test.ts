import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { onCaughtError } from './caught'

const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

afterEach(() => {
  spy.mockClear()
})

describe('onCaughtError', () => {
  it('says nothing about an ApiError a boundary drew', () => {
    onCaughtError(new ApiError('network', 'fetch failed'), { componentStack: 'at Providers' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('logs anything else with its component stack', () => {
    const error = new Error('boom')
    onCaughtError(error, { componentStack: 'at Providers' })
    expect(spy).toHaveBeenCalledWith(error, 'at Providers')
  })
})
