import { describe, expect, it } from 'vitest'
import { errorLine, shortError } from './line'

describe('errorLine', () => {
  it('reads the line from both shapes the daemon writes', () => {
    expect(errorLine("missing field 'machine' at line 7")).toBe(7)
    expect(
      errorLine(
        'workspace `site` at /home/me/.config/yantra/workspaces/site.toml is not valid TOML: TOML parse error at line 2, column 7',
      ),
    ).toBe(2)
  })

  it('is null for an error that names no line', () => {
    expect(errorLine('workspace `site` has an empty `repo`')).toBeNull()
  })
})

describe('shortError', () => {
  it('keeps the last clause and drops the position', () => {
    expect(shortError("missing field 'machine' at line 7")).toBe("missing field 'machine'")
    expect(shortError('workspace `site` at … is not valid TOML: TOML parse error at line 2, column 7')).toBe(
      'TOML parse error',
    )
    expect(shortError('workspace `site` has an empty `repo`')).toBe('workspace `site` has an empty `repo`')
  })
})
