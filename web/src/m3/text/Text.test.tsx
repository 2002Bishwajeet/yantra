import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Eyebrow, Mono, Text } from './Text'

describe('Text', () => {
  it('names its scale on the element and emphasis as an attribute', () => {
    render(
      <Text scale="title-large" emphasized as="h2">
        Running
      </Text>,
    )
    const heading = screen.getByRole('heading', { level: 2, name: 'Running' })
    expect(heading.dataset.scale).toBe('title-large')
    expect(heading.hasAttribute('data-emphasized')).toBe(true)
  })

  it('is a span by default and clips on request', () => {
    render(
      <Text scale="body-medium" clip tone="variant">
        a long supporting line
      </Text>,
    )
    const span = screen.getByText('a long supporting line')
    expect(span.tagName).toBe('SPAN')
    expect(span.className).toContain('m3-clip')
    expect(span.dataset.tone).toBe('variant')
  })

  it('draws numbers in mono and the eyebrow uppercase', () => {
    render(
      <>
        <Mono>3h 41m</Mono>
        <Eyebrow as="h2">Needs you</Eyebrow>
      </>,
    )
    expect(screen.getByText('3h 41m').className).toBe('m3-mono')
    expect(screen.getByRole('heading', { name: 'Needs you' }).className).toBe('m3-eyebrow')
  })
})
