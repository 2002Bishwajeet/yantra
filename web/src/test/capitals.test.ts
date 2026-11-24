import { describe, expect, it } from 'vitest'
import { lowerLines } from './capitals'

/** Detached, so the suite's own guard does not read these pages. */
function page(html: string) {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

const supporting = (line: string) => `<span class="m3-list-item__supporting">${line}</span>`

describe('the capitals guard (Y-763)', () => {
  it.each([
    'not yet · not checked yet · Check asks a machine over ssh',
    'done · 1 workspace made',
    'asleep · last seen 3h',
    'ready · 4 of 4',
    'shared from another account · not supported yet',
    'asking the daemon',
  ])('finds the computed line "%s"', (line) => {
    expect(lowerLines(page(supporting(line)))).toEqual([line])
  })

  it('reads the supporting line of an M3 row', () => {
    expect(lowerLines(page('<span class="m3-row__supporting">online · macOS</span>'))).toEqual(['online · macOS'])
  })

  it('reads each place a supporting line is drawn', () => {
    const drawn = page(`
      <span class="m3-list-item__supporting"><span class="m3-state">in progress · 0 of 2 machines ready</span></span>
      <li class="setup__sub"><span class="m3-text">the key is made when the first machine joins</span></li>
      <span class="m3-text setup__said">opens the dashboard · runs no session</span>
      <div class="setup__said"><span class="m3-text">missing tmux</span><span class="m3-text">no load reading yet</span></div>
      <p class="machines__about">linux · no sessions</p>
      <span class="machines__summary">not checked</span>
      <span class="machines__detail">not found</span>
      <div class="machines__head"><span class="m3-chip">not checked</span></div>
    `)
    expect(lowerLines(drawn)).toHaveLength(9)
  })

  it('passes a line that starts with a capital or a number', () => {
    const drawn = page(supporting('Not yet · not checked yet') + supporting('0 of 2 machines ready') + supporting(''))
    expect(lowerLines(drawn)).toEqual([])
  })

  it('lets a line start with a name that is spelled in lower case', () => {
    const names = ['macOS · no sessions', 'gh not signed in', 'tmux needs your password', 'pi-5.tail3a1b.ts.net', 'github.com/o/r']
    expect(lowerLines(page(names.map(supporting).join('')))).toEqual([])
  })

  it('lets a line start inside a marked name, and only there', () => {
    const marked = '<span class="m3-row__supporting"><span data-name>cachyos-g14</span> · 2 windows</span>'
    expect(lowerLines(page(marked))).toEqual([])
    expect(lowerLines(page('<span class="m3-row__supporting">idle · <span data-name>cachyos-g14</span></span>'))).toEqual([
      'idle · cachyos-g14',
    ])
  })

  it('lets a line start with a machine only where the page names that machine', () => {
    const line = '<div class="setup__said"><span class="m3-text">pi did not take the appliance’s key.</span></div>'
    expect(lowerLines(page(`<span class="setup__machine">pi</span>${line}`))).toEqual([])
    expect(lowerLines(page(line))).toEqual(['pi did not take the appliance’s key.'])
  })
})
