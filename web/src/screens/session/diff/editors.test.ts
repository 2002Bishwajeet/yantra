import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorUrl, keepEditor, recallEditor } from './editors'

const WORKTREE = '/home/u/.yantra/worktrees/chat/site/0a1b'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('an editor link', () => {
  it('names the machine as an ssh destination and the file under the worktree', () => {
    expect(editorUrl('vscode', 'cachyos-g14', WORKTREE, 'src/new.rs', 12)).toBe(
      'vscode://vscode-remote/ssh-remote+cachyos-g14/home/u/.yantra/worktrees/chat/site/0a1b/src/new.rs:12',
    )
    expect(editorUrl('cursor', 'cachyos-g14', WORKTREE, 'src/new.rs')).toBe(
      'cursor://vscode-remote/ssh-remote+cachyos-g14/home/u/.yantra/worktrees/chat/site/0a1b/src/new.rs',
    )
  })

  it('leaves the line off for Zed, whose ssh scheme has none', () => {
    expect(editorUrl('zed', 'cachyos-g14', WORKTREE, 'src/new.rs', 12)).toBe(
      'zed://ssh/cachyos-g14/home/u/.yantra/worktrees/chat/site/0a1b/src/new.rs',
    )
  })

  it('percent-encodes each segment, for spaces, unicode and reserved characters', () => {
    expect(editorUrl('vscode', 'box', '/srv/my work', 'docs/résumé #1.md', 3)).toBe(
      'vscode://vscode-remote/ssh-remote+box/srv/my%20work/docs/r%C3%A9sum%C3%A9%20%231.md:3',
    )
    expect(editorUrl('zed', 'box', '/srv/w', '日本/a?b.txt')).toBe('zed://ssh/box/srv/w/%E6%97%A5%E6%9C%AC/a%3Fb.txt')
  })

  it('survives a worktree with a trailing slash and a path with a leading one', () => {
    expect(editorUrl('vscode', 'box', '/srv/w/', '/a.rs')).toBe('vscode://vscode-remote/ssh-remote+box/srv/w/a.rs')
  })
})

describe('the remembered editor', () => {
  it('is VS Code until one is used, then the last one', () => {
    expect(recallEditor()).toBe('vscode')
    keepEditor('zed')
    expect(recallEditor()).toBe('zed')
  })

  it('ignores a value it does not know', () => {
    localStorage.setItem('yantra.editor', 'emacs')
    expect(recallEditor()).toBe('vscode')
  })

  it('works with storage blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    vi.stubGlobal('localStorage', blocked)
    expect(recallEditor()).toBe('vscode')
    expect(() => keepEditor('cursor')).not.toThrow()
  })
})
