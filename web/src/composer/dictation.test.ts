import { describe, expect, it } from 'vitest'
import { insertDictation } from './dictation'

describe('insertDictation', () => {
  it('fills an empty field and puts the caret after the words', () => {
    expect(insertDictation('', 0, 0, ' use tokio ')).toEqual({ text: 'use tokio', caret: 9 })
  })

  it('adds a space only where the words would touch another word', () => {
    expect(insertDictation('runcargo', 3, 3, 'the')).toEqual({ text: 'run the cargo', caret: 7 })
    expect(insertDictation('run cargo', 4, 4, 'the')).toEqual({ text: 'run the cargo', caret: 7 })
  })

  it('replaces the selection, and keeps markup as text', () => {
    expect(insertDictation('say X now', 4, 5, '<b>*hi*</b>')).toEqual({ text: 'say <b>*hi*</b> now', caret: 15 })
  })

  it('leaves the text alone for no words, and clamps a caret past the end', () => {
    expect(insertDictation('abc', 1, 2, '  ')).toEqual({ text: 'abc', caret: 2 })
    expect(insertDictation('abc', 9, 9, 'd')).toEqual({ text: 'abc d', caret: 5 })
  })
})
