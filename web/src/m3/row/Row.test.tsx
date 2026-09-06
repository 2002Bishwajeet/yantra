import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { renderRouted } from '@/test/inRouter'
import { State } from '../mark/Mark'
import { Row, RowText } from './Row'

afterEach(cleanup)

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
})
