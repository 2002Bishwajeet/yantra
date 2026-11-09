import { describe, expect, it } from 'vitest'
import { extractFenceLanguage, extractFenceTitle, fileTarget, linkTarget, parseMarkdownFileLink } from './markdown.logic'

const WT = '/home/biswa/work/site'

describe('fence info', () => {
  it('reads the language, and maps gitignore to ini', () => {
    expect(extractFenceLanguage('language-rust')).toBe('rust')
    expect(extractFenceLanguage('foo language-ts')).toBe('ts')
    expect(extractFenceLanguage(undefined)).toBe('text')
    expect(extractFenceLanguage('language-gitignore')).toBe('ini')
  })

  it('reads a title attribute or a file name token', () => {
    expect(extractFenceTitle('title="src/a.rs"')).toBe('src/a.rs')
    expect(extractFenceTitle('filename=a.ts')).toBe('a.ts')
    expect(extractFenceTitle('{1,3} web/a.tsx')).toBe('web/a.tsx')
    expect(extractFenceTitle('{1,3}')).toBeNull()
    expect(extractFenceTitle(undefined)).toBeNull()
  })
})

describe('inline code paths', () => {
  it('links a relative path, with its line', () => {
    expect(fileTarget('src/main.rs:12', WT)).toEqual({ path: 'src/main.rs', line: 12 })
    expect(fileTarget('./web/a.ts', WT)).toEqual({ path: 'web/a.ts' })
  })

  it.each(['foo()', 'example.com/x', 'v1.2.3', 'npm i', 'dir/', 'a/b', '../up/a.ts', '~/a.ts'])('leaves %s as code', (text) => {
    expect(fileTarget(text, WT)).toBeNull()
  })

  it('strips the worktree from an absolute path, and leaves one outside it', () => {
    expect(fileTarget(`${WT}/src/a.rs:3`, WT)).toEqual({ path: 'src/a.rs', line: 3 })
    expect(fileTarget('/etc/hosts.conf', WT)).toBeNull()
    expect(fileTarget(`${WT}-other/a.rs`, WT)).toBeNull()
  })

  it('links nothing before the worktree is known', () => {
    expect(fileTarget('src/main.rs', null)).toBeNull()
  })
})

describe('markdown destinations', () => {
  it('reads a file, a line in the hash, and refuses URLs and anchors', () => {
    expect(parseMarkdownFileLink('src/a.rs#L7')).toEqual({ path: 'src/a.rs', line: 7 })
    expect(parseMarkdownFileLink('https://example.com/a.rs')).toBeNull()
    expect(parseMarkdownFileLink('mailto:me@example.com')).toBeNull()
    expect(parseMarkdownFileLink('#top')).toBeNull()
    expect(linkTarget(`${WT}/web/a.ts:4`, WT)).toEqual({ path: 'web/a.ts', line: 4 })
    expect(linkTarget('web/a.ts', null)).toBeNull()
  })
})
