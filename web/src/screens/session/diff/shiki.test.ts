/**
 * The two stand-ins in vite.config.ts, run for real: Vitest reads the same
 * aliases, so this highlights through them as the build does.
 */
import { describe, expect, it } from 'vitest'
import { DiffHunksRenderer, getFiletypeFromFileName, getSharedHighlighter, parsePatchFiles } from '@pierre/diffs'
import { knows } from './shiki'

const patch = (name: string) =>
  parsePatchFiles(
    [`diff --git a/${name} b/${name}`, 'index 1..2 100644', `--- a/${name}`, `+++ b/${name}`, '@@ -1 +1 @@', '-let a = 1', '+let b = 2', ''].join(
      '\n',
    ),
  )[0]!.files[0]!

describe('the trimmed highlighter', () => {
  it('knows the grammars a diff of this repository shows, by the names Pierre gives files', () => {
    for (const name of ['a.rs', 'a.ts', 'a.tsx', 'a.json', 'a.toml', 'a.yml', 'a.md', 'a.css', 'a.sh', 'Dockerfile']) {
      expect(knows(getFiletypeFromFileName(name)), name).toBe(true)
    }
    expect(knows(getFiletypeFromFileName('a.swift'))).toBe(false)
  })

  it('colours Rust with Pierre’s own theme', async () => {
    const highlighter = await getSharedHighlighter({ themes: ['pierre-dark', 'pierre-light'], langs: ['rust', 'typescript'] })
    const html = highlighter.codeToHtml('fn main() { let a = 1; }', { lang: 'rust', theme: 'pierre-dark' })
    expect(html).toMatch(/<span style="color:#[0-9a-f]{6}/i)
    expect(html).toContain('main')
  })

  it('renders a diff of a known language with tokens, and of an unknown one as text', async () => {
    const draw = async (name: string, lang?: 'text') => {
      const file = { ...patch(name), ...(lang ? { lang } : {}) }
      const renderer = new DiffHunksRenderer({ theme: { light: 'pierre-light', dark: 'pierre-dark' } })
      return renderer.asyncRender(file)
    }
    const ts = await draw('a.ts')
    expect(JSON.stringify(ts)).toContain('style')
    await expect(draw('a.swift', 'text')).resolves.toBeTruthy()
  })
})
