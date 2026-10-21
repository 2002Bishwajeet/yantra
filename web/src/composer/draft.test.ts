import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { draftId, keepDraft, recallDraft, useDraft } from './draft'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the draft', () => {
  it('is kept per thread, and per workspace before the first turn', () => {
    expect(draftId('web', '1a2b')).toBe('1a2b')
    expect(draftId('web', null)).toBe('workspace/web')
    keepDraft('1a2b', 'one')
    keepDraft('9f8e', 'two')
    expect(recallDraft('1a2b')).toBe('one')
    expect(recallDraft('9f8e')).toBe('two')
    expect(localStorage.getItem('yantra.chat.draft.1a2b')).toBe('one')
  })

  it('writes after a pause and loads again on a remount', () => {
    const first = renderHook(() => useDraft('1a2b'))
    act(() => first.result.current[1]('half a thought'))
    expect(recallDraft('1a2b')).toBe('')
    act(() => void vi.advanceTimersByTime(300))
    expect(recallDraft('1a2b')).toBe('half a thought')
    first.unmount()

    const second = renderHook(() => useDraft('1a2b'))
    expect(second.result.current[0]).toBe('half a thought')
  })

  it('keeps the last words when the page goes inside the pause', () => {
    const { result } = renderHook(() => useDraft('1a2b'))
    act(() => result.current[1]('typed just now'))
    window.dispatchEvent(new Event('pagehide'))
    expect(recallDraft('1a2b')).toBe('typed just now')
  })

  it('is cleared when the words are cleared, as a send does', () => {
    keepDraft('1a2b', 'to send')
    const { result } = renderHook(() => useDraft('1a2b'))
    act(() => result.current[1](''))
    act(() => void vi.advanceTimersByTime(300))
    expect(localStorage.getItem('yantra.chat.draft.1a2b')).toBeNull()
  })

  it('lets the issue text in only when nothing was kept', () => {
    expect(renderHook(() => useDraft('1a2b', 'Work on o/r#1')).result.current[0]).toBe('Work on o/r#1')
    keepDraft('9f8e', 'my own words')
    expect(renderHook(() => useDraft('9f8e', 'Work on o/r#1')).result.current[0]).toBe('my own words')
  })

  it('moves to the thread key when the first turn names the thread', () => {
    const { result, rerender } = renderHook(({ id }) => useDraft(id), { initialProps: { id: 'workspace/web' } })
    act(() => result.current[1]('typed'))
    act(() => void vi.advanceTimersByTime(300))
    expect(recallDraft('workspace/web')).toBe('typed')
    rerender({ id: '1a2b' })
    act(() => void vi.advanceTimersByTime(300))
    expect(recallDraft('workspace/web')).toBe('')
    expect(recallDraft('1a2b')).toBe('typed')
  })

  it('still works when the browser refuses site data', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const { result } = renderHook(() => useDraft('1a2b', 'seed'))
    expect(result.current[0]).toBe('seed')
    act(() => result.current[1]('still typing'))
    act(() => void vi.advanceTimersByTime(300))
    expect(result.current[0]).toBe('still typing')
    act(() => result.current[1](''))
    expect(result.current[0]).toBe('')
  })
})
