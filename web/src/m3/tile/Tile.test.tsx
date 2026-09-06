import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { GitBranch } from 'lucide-react'
import { IconTile, Tile } from './Tile'
import { tileColor } from './tileColor'

afterEach(cleanup)

describe('Tile', () => {
  it('draws the first letter on the canonical colour and hides itself', () => {
    render(<Tile name="yantra-web" data-testid="t" />)
    const tile = screen.getByTestId('t')
    expect(tile.textContent).toBe('Y')
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    expect(tile.style.background).toBe('rgb(72, 103, 75)')
  })

  it('gives an unknown name a stable colour from the same ten', () => {
    expect(tileColor('scratch')).toBe(tileColor('scratch'))
    expect(tileColor('scratch')).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('has a small size and an icon form', () => {
    render(
      <>
        <Tile name="landing" size="small" data-testid="s" />
        <IconTile data-testid="i">
          <GitBranch />
        </IconTile>
      </>,
    )
    expect(screen.getByTestId('s').dataset.size).toBe('small')
    expect(screen.getByTestId('i').querySelector('svg')).toBeTruthy()
  })
})
