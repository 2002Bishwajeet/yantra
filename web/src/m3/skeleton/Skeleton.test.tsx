import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { Skeleton } from './Skeleton'

describe('Skeleton', () => {
  it('is hidden from readers and shaped by a word', () => {
    render(<Skeleton shape="round" data-testid="s" />)
    const el = screen.getByTestId('s')
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.dataset.shape).toBe('round')
    expect(el.dataset.slot).toBe('skeleton')
  })

  it('draws a card and a row from the card and row tokens', () => {
    render(
      <>
        <Skeleton data-testid="card" lines={4} shape="card" />
        <Skeleton data-testid="row" shape="row" />
      </>,
    )
    expect(screen.getByTestId('card').dataset.shape).toBe('card')
    expect(screen.getByTestId('card').style.getPropertyValue('--m3-skeleton-lines')).toBe('4')
    expect(screen.getByTestId('row').dataset.shape).toBe('row')
    const css = readFileSync(resolve(process.cwd(), 'src/m3/skeleton/Skeleton.css'), 'utf8')
    expect(css).toContain('calc(2 * var(--m3-card-padding) + var(--m3-skeleton-lines, 3) * var(--m3-row-min-height))')
    expect(css).toContain('border-radius: var(--m3-card-radius);')
    expect(css).toMatch(/\[data-shape="row"\] \{\s*height: var\(--m3-row-min-height\);/)
  })
})
