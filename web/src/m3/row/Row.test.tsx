import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { renderRouted } from '@/test/inRouter'
import { State } from '../mark/Mark'
import { Row, RowText } from './Row'

describe('Row', () => {
  it('is a plain div with its two lines when it goes nowhere', () => {
    render(
      <Row tone="selected" data-testid="row">
        <RowText headline="yantra-web" supporting={<State state="needs" size="small">waiting · cachyos-g14</State>} />
      </Row>,
    )
    const row = screen.getByTestId('row')
    expect(row.tagName).toBe('DIV')
    expect(row.dataset.tone).toBe('selected')
    expect(row.className).not.toContain('m3-interactive')
    expect(screen.getByText('yantra-web')).toBeTruthy()
    expect(screen.getByText('waiting · cachyos-g14')).toBeTruthy()
  })

  it('is the link itself, with the hit area, when rendered as one', async () => {
    await renderRouted(
      <Row render={<Link to="/" />}>
        <RowText headline="landing" />
      </Row>,
    )
    const link = screen.getByRole('link', { name: 'landing' })
    expect(link.className).toContain('m3-row')
    expect(link.className).toContain('m3-interactive')
    expect(link.dataset.tone).toBe('lowest')
  })

  // jsdom applies no stylesheet; a flex line cut its words with no ellipsis (Y-566).
  it('draws the supporting line as a block, so a cut word gets an ellipsis', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/m3/row/Row.css'), 'utf8')
    expect(css).toMatch(/\.m3-row__supporting \{\s*display: block;/)
    expect(css).toMatch(/\.m3-row__supporting > \.m3-state \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/s)
  })

  // A state then an age: the block rule alone would put the age flush against the state's line.
  it('keeps the 6 px gap when a state is followed by a sibling', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/m3/row/Row.css'), 'utf8')
    expect(css).toMatch(
      /\.m3-row__supporting:has\(> \.m3-state \+ \*\) \{\s*display: flex;\s*align-items: center;\s*gap: 6px;/,
    )
    render(
      <Row>
        <RowText
          headline="landing"
          supporting={
            <>
              <State state="running" size="small">running</State>
              <span data-testid="age">3h</span>
            </>
          }
        />
      </Row>,
    )
    expect(screen.getByTestId('age').previousElementSibling?.className).toContain('m3-state')
  })
})
