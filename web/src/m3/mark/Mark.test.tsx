import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Mark, State, type MarkState } from './Mark'
import { word } from './word'

afterEach(cleanup)

const states: MarkState[] = ['needs', 'running', 'idle', 'unknown', 'done', 'failed']

describe('State', () => {
  it.each(states)('%s carries its word beside the mark', (state) => {
    render(<State state={state} />)
    const el = screen.getByText(word[state])
    expect(el.dataset.state).toBe(state)
    const mark = el.querySelector('.m3-mark')!
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.getAttribute('data-state')).toBe(state)
  })

  it('takes a longer word from the caller', () => {
    render(<State state="needs">waiting for trust · cachyos-g14</State>)
    expect(screen.getByText('waiting for trust · cachyos-g14')).toBeTruthy()
  })

  it('has a small size for a row', () => {
    render(<Mark state="running" size="small" data-testid="m" />)
    expect(screen.getByTestId('m').dataset.size).toBe('small')
  })
})
