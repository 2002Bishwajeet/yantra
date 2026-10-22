import { describe, expect, it } from 'vitest'
import {
  buildPromptHistoryEntries,
  recallablePrompt,
  stepPromptHistory,
  type PromptHistoryPosition,
} from './history'

const entries = buildPromptHistoryEntries([
  { id: 'm1', who: 'you', text: 'first' },
  { id: 'a1', who: 'agent', text: 'reply' },
  { id: 'm2', who: 'you', text: 'second' },
  { id: 'm3', who: 'you', text: 'third' },
])

const backward = (position: PromptHistoryPosition | null, currentPrompt: string) =>
  stepPromptHistory({ direction: 'backward', entries, position, currentPrompt })
const forward = (position: PromptHistoryPosition | null, currentPrompt: string) =>
  stepPromptHistory({ direction: 'forward', entries, position, currentPrompt })

describe('recallablePrompt', () => {
  it('drops the image paths the daemon sent after the words', () => {
    expect(recallablePrompt('look\n/home/u/.yantra/keep/web/1a2b/images/Y01-1.png\n/tmp/x/2.webp')).toBe('look')
  })

  it('keeps a path inside the words, and a prompt that is only images is empty', () => {
    expect(recallablePrompt('see /tmp/a.png then\nfix it')).toBe('see /tmp/a.png then\nfix it')
    expect(recallablePrompt('/tmp/a.png')).toBe('')
  })
})

describe('buildPromptHistoryEntries', () => {
  it('collapses consecutive duplicates onto the newest message id', () => {
    const collapsed = buildPromptHistoryEntries([
      { id: 'm1', who: 'you', text: 'same' },
      { id: 'm2', who: 'you', text: 'same' },
      { id: 'm3', who: 'you', text: 'other' },
      { id: 'm4', who: 'you', text: 'same' },
    ])
    expect(collapsed).toEqual([
      { id: 'm2', prompt: 'same' },
      { id: 'm3', prompt: 'other' },
      { id: 'm4', prompt: 'same' },
    ])
  })

  it('skips the agent and its thinking, and has no entry for a thread with no prompts', () => {
    expect(
      buildPromptHistoryEntries([
        { id: 'a1', who: 'agent', text: 'hello' },
        { id: 't1', who: 'thinking', text: 'hm' },
      ]),
    ).toEqual([])
    expect(stepPromptHistory({ direction: 'backward', entries: [], position: null, currentPrompt: '' })).toBeNull()
    expect(stepPromptHistory({ direction: 'forward', entries: [], position: null, currentPrompt: '' })).toBeNull()
  })
})

describe('stepPromptHistory', () => {
  it('walks back from the newest entry', () => {
    const first = backward(null, '')
    expect(first).toEqual({ position: { entryId: 'm3', recalled: 'third' }, prompt: 'third' })
    expect(backward(first!.position, 'third')?.prompt).toBe('second')
  })

  it('stops at the oldest entry', () => {
    expect(backward({ entryId: 'm1', recalled: 'first' }, 'first')).toBeNull()
  })

  it('walks forward and empties the field past the newest entry', () => {
    const newer = forward({ entryId: 'm2', recalled: 'second' }, 'second')
    expect(newer?.prompt).toBe('third')
    expect(forward(newer!.position, 'third')).toEqual({ position: null, prompt: '' })
  })

  it('treats an edited recall as a fresh draft', () => {
    const position: PromptHistoryPosition = { entryId: 'm3', recalled: 'third' }
    expect(backward(position, 'third edited')).toBeNull()
    expect(forward(position, 'third edited')).toBeNull()
    expect(backward(position, '')?.position).toEqual({ entryId: 'm3', recalled: 'third' })
  })

  it('does not overwrite a typed draft', () => {
    expect(backward(null, 'half a thought')).toBeNull()
  })

  it('follows the entry by id when the list changes under it', () => {
    const grown = buildPromptHistoryEntries([
      { id: 'm0', who: 'you', text: 'zeroth' },
      { id: 'm1', who: 'you', text: 'A' },
      { id: 'm2', who: 'you', text: 'B' },
      { id: 'm3', who: 'you', text: 'A' },
    ])
    const older = stepPromptHistory({
      direction: 'backward',
      entries: grown,
      position: { entryId: 'm1', recalled: 'A' },
      currentPrompt: 'A',
    })
    expect(older?.prompt).toBe('zeroth')
    const missing = stepPromptHistory({
      direction: 'forward',
      entries: grown,
      position: { entryId: 'gone', recalled: 'not sent' },
      currentPrompt: 'not sent',
    })
    expect(missing).toBeNull()
  })

  it('falls back to matching text when a duplicate collapse retires the id', () => {
    const collapsed = buildPromptHistoryEntries([
      { id: 'm1', who: 'you', text: 'first' },
      { id: 'm3', who: 'you', text: 'A' },
    ])
    const step = stepPromptHistory({
      direction: 'backward',
      entries: collapsed,
      position: { entryId: 'm2', recalled: 'A' },
      currentPrompt: 'A',
    })
    expect(step?.prompt).toBe('first')
  })
})
