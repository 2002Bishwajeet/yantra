import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from './PageHeader'

const css = readFileSync(resolve(process.cwd(), 'src/m3/page/PageHeader.css'), 'utf8')
const shell = readFileSync(resolve(process.cwd(), 'src/shell/Shell.css'), 'utf8')

describe('PageHeader', () => {
  it('draws the title as the one h1', () => {
    render(<PageHeader title="Fleet" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Fleet' }).className).toContain('m3-page-header__h1')
  })

  it('draws the eyebrow, the subtitle, the stamp and the actions', () => {
    render(
      <PageHeader
        actions={<button type="button">Reorder</button>}
        eyebrow="Machine"
        stamp={<span>looked 0s ago</span>}
        subtitle={<span>online</span>}
        title="pi-5"
      />,
    )
    expect(screen.getByText('Machine')).toBeTruthy()
    expect(screen.getByText('online')).toBeTruthy()
    expect(screen.getByText('looked 0s ago').closest('.m3-page-header__stamp')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reorder' }).closest('.m3-page-header__actions')).toBeTruthy()
  })

  it('draws no landmark of its own, so the shell keeps its one banner', () => {
    render(<PageHeader title="Fleet" />)
    expect(screen.queryByRole('banner')).toBeNull()
  })

  it('marks a header with only a title as bare, which the phone then hides', () => {
    const { rerender } = render(<PageHeader title="Fleet" />)
    expect(document.querySelector('[data-slot="page-header"]')?.hasAttribute('data-bare')).toBe(true)
    rerender(<PageHeader actions={<button type="button">Go</button>} title="Fleet" />)
    expect(document.querySelector('[data-slot="page-header"]')?.hasAttribute('data-bare')).toBe(false)
  })

  it('is one flex row of the token height, with the title scale from the tokens', () => {
    expect(css).toMatch(/\.m3-page-header \{[^}]*display: flex;[^}]*min-height: var\(--m3-page-header-height\);/s)
    expect(css).toMatch(/\.m3-page-header__h1 \{[^}]*font: var\(--m3-page-title\);/s)
  })

  it('hides the h1 on a phone and keeps the stamp and the actions in the row', () => {
    expect(shell).toMatch(/\[data-shell="phone"\] \.shell__main h1 \{\s*display: none;/)
    expect(css).toMatch(/\[data-shell="phone"\] \.m3-page-header\[data-bare\] \{\s*display: none;/)
    expect(css).not.toMatch(/\[data-shell="phone"\] \.m3-page-header[^{]*\{[^}]*flex-direction: column/)
  })
})
