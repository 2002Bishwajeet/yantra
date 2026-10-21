import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Page } from './Page'

const css = readFileSync(resolve(process.cwd(), 'src/m3/page/Page.css'), 'utf8')

describe('Page', () => {
  it('is wide unless told it is a reading column', () => {
    render(
      <>
        <Page data-testid="wide">a</Page>
        <Page data-testid="reading" width="reading">
          b
        </Page>
      </>,
    )
    expect(screen.getByTestId('wide').dataset.width).toBe('wide')
    expect(screen.getByTestId('reading').dataset.width).toBe('reading')
  })

  it('takes both widths and the gap from tokens, and centres itself', () => {
    expect(css).toMatch(/\.m3-page \{[^}]*gap: var\(--m3-page-gap\);/)
    expect(css).toMatch(/\.m3-page \{[^}]*max-width: var\(--m3-page-max-wide\);/)
    expect(css).toMatch(/\[data-width="reading"\] \{\s*max-width: var\(--m3-page-max-reading\);/)
    expect(css).toMatch(/margin-inline: auto;/)
  })

  it('has the same inset from the top under every shell', () => {
    expect(css).toMatch(/padding-block-start: var\(--m3-page-top\);/)
    expect(css).not.toContain('data-shell')
  })

  it('passes a class and an attribute on', () => {
    render(
      <Page aria-busy="true" className="mine" data-testid="page">
        x
      </Page>,
    )
    const page = screen.getByTestId('page')
    expect(page.className).toContain('m3-page')
    expect(page.className).toContain('mine')
    expect(page.getAttribute('aria-busy')).toBe('true')
  })
})
