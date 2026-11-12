import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatMarkdown } from './ChatMarkdown'
import { CodeBlock } from './CodeBlock'

// One flag decides whether the real highlighter runs or fails.
const broken = vi.hoisted(() => ({ on: false }))
vi.mock('../diff/shiki', async (original) => {
  const real = await original<typeof import('../diff/shiki')>()
  return {
    ...real,
    createHighlighter: (...args: Parameters<typeof real.createHighlighter>) =>
      broken.on ? Promise.reject(new Error('grammar failed')) : real.createHighlighter(...args),
  }
})

beforeEach(() => {
  broken.on = false
})
afterEach(cleanup)

describe('the code block', () => {
  it('colours a known language with token spans, in both themes', async () => {
    const { container } = render(<CodeBlock code="fn main() { let a = 1; }" language="rust" title={null} />)
    await waitFor(() => expect(container.querySelectorAll('.chat__code-body span[style]').length).toBeGreaterThan(2), { timeout: 10_000 })
    const span = container.querySelector<HTMLElement>('.chat__code-body span[style]')!
    expect(span.getAttribute('style')).toMatch(/--shiki-light:\s*#[0-9a-f]{6}/i)
    expect(span.getAttribute('style')).toMatch(/--shiki-dark:\s*#[0-9a-f]{6}/i)
    expect(container.querySelector('code')?.textContent).toBe('fn main() { let a = 1; }\n')
    expect(screen.getByText('rust')).toBeTruthy()
  })

  it('draws a language it does not list as text, and a fence title in the header', async () => {
    const { container } = render(<CodeBlock code="let x = 1" language="swift" title="a.swift" />)
    await waitFor(() => expect(container.querySelector('.chat__code-line')).not.toBeNull(), { timeout: 10_000 })
    expect(container.querySelector('code')?.textContent).toBe('let x = 1\n')
    expect(screen.getByText('a.swift')).toBeTruthy()
  })

  it('falls back to the plain code when the highlighter fails', async () => {
    broken.on = true
    const { container } = render(<CodeBlock code="fn broken() {}" language="rust" title={null} />)
    await waitFor(() => expect(container.querySelector('.chat__code-body')?.textContent).toBe('fn broken() {}'))
    expect(container.querySelector('.chat__code-body span[style]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
  })

  it('copies the code with no control character, and keeps tab and newline (Y-779)', async () => {
    const writeText = vi.fn((_: string) => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    broken.on = true
    const { container } = render(
      <CodeBlock code={'if x:\n\techo a\u001b[201~\r\nrm b\u007f\u009b'} language="sh" title={null} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith('if x:\n\techo a[201~\nrm b')
    await waitFor(() => expect(container.querySelector('.chat__code-body')?.textContent).toBe('if x:\n\techo a[201~\nrm b'))
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })

  it('takes the header from a fence title, and a plain fence from its language', () => {
    render(<ChatMarkdown machine="m" text={'```rust title="src/a.rs"\nfn a() {}\n```\n\n```\nplain\n```'} worktree={null} />)
    expect(screen.getByText('src/a.rs')).toBeTruthy()
    expect(screen.getByText('text')).toBeTruthy()
  })
})
