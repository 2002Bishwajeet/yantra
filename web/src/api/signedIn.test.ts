import { afterEach, describe, expect, it, vi } from 'vitest'
import { answer as answered } from '../test/daemon'
import { fetchJson, look } from './client'
import { ApiError } from './errors'
import { signedIn, useSignedOut } from './signedIn'
import { renderHook, act } from '@testing-library/react'

afterEach(() => {
  vi.unstubAllGlobals()
  signedIn()
})

const SAID = 'sign in from the dashboard, or run this on the hub'
const daemon = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answered(status, body))))

describe('a 401 from the daemon', () => {
  it('is unauthenticated, with the daemon’s words, and signs this device out', async () => {
    daemon(401, SAID)
    const { result } = renderHook(useSignedOut)
    expect(result.current).toBe(false)

    const error = await fetchJson('/api/sessions').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'unauthenticated', status: 401, said: SAID, retryable: false })
    expect(result.current).toBe(true)
  })

  it('on a look is a failed reading, not a dead daemon, and signs this device out', async () => {
    daemon(401, SAID)
    const { result } = renderHook(useSignedOut)

    const reading = await look('/api/machines', new AbortController().signal)

    expect(reading).toEqual({ looked: 'failed', age_seconds: 0, error: 'this device is not signed in' })
    expect(result.current).toBe(true)
    act(() => signedIn())
    expect(result.current).toBe(false)
  })

  it('a 403 does not sign this device out', async () => {
    daemon(403, 'a write from https://evil.example is refused')
    const { result } = renderHook(useSignedOut)

    await fetchJson('/api/layout', { method: 'PUT' }).catch(() => {})

    expect(result.current).toBe(false)
  })
})
