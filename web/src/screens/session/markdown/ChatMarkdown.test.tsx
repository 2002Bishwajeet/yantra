/* Y-785, F-10: markdown from an agent or from GitHub never makes the browser ask for an image. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Looked, Pull } from '@/api'
import { pulls } from '@/contract.gen'
import { answer } from '@/test/daemon'
import { Checks } from '../Checks'
import { ChatMarkdown } from './ChatMarkdown'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const REMOTE = 'https://x.example/y.png'

const show = (text: string, worktree: string | null = null) =>
  render(<ChatMarkdown machine="box" text={text} worktree={worktree} />).container

describe('an image in markdown', () => {
  it('draws a new-tab link to the address, named by the alt, and no img', () => {
    const drawn = show(`before ![a diagram](${REMOTE}) after`)
    expect(drawn.querySelector('img')).toBeNull()
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe(REMOTE)
    expect(links[0]!.textContent).toBe('a diagram')
    expect(links[0]!.getAttribute('rel')).toBe('noreferrer')
    expect(links[0]!.getAttribute('target')).toBe('_blank')
  })

  it('names an image with no alt "Image"', () => {
    const drawn = show(`![](${REMOTE})`)
    expect(drawn.querySelector('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'Image' }).getAttribute('href')).toBe(REMOTE)
  })

  it('opens a path in the worktree in the editor, as a file link does', () => {
    const drawn = show('![the chart](docs/chart.png)', '/home/me/repo')
    expect(drawn.querySelector('img')).toBeNull()
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toContain('/home/me/repo/docs/chart.png')
    expect(link.textContent).toBe('the chart')
    expect(link.getAttribute('target')).toBeNull()
  })

  it('draws the alt as text where the sanitiser left no address', () => {
    const drawn = show('![a pixel](data:image/png;base64,AAAA)')
    expect(drawn.querySelector('img')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(drawn.textContent).toBe('a pixel')
  })

  it('draws raw img HTML as no element', () => {
    const drawn = show(`<img src="${REMOTE}" alt="raw">`)
    expect(drawn.querySelector('img')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('draws an image inside a link as one link, to the link', () => {
    const drawn = show(`[![badge](${REMOTE})](https://ci.example/run)`)
    expect(drawn.querySelector('img')).toBeNull()
    const link = screen.getByRole('link', { name: 'badge' })
    expect(link.getAttribute('href')).toBe('https://ci.example/run')
    expect(link.querySelector('a')).toBeNull()
  })

  it('draws no img from a GitHub check summary', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const watched = pulls.data[0]! as Pull
    const check = { ...watched.checks[0]!, output: { title: '1 failed', summary: `![coverage](${REMOTE})` } }
    const read: Looked<Pull[]> = { looked: 'ok', age_seconds: 0, data: [{ ...watched, checks: [check] }] }
    vi.stubGlobal('fetch', () => Promise.resolve(answer(200, read)))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Checks onFix={() => {}} pr={{ number: watched.number, url: watched.url }} />
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Checks' }))
    const surface = await screen.findByRole('dialog', { name: `Checks on PR #${watched.number}` })
    const link = await within(surface).findByRole('link', { name: 'coverage' })
    expect(link.getAttribute('href')).toBe(REMOTE)
    expect(document.querySelector('img')).toBeNull()
  })
})
