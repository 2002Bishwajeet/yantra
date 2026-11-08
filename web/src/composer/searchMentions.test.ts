import { describe, expect, it } from 'vitest'
import { SHOWN, searchMentions } from './searchMentions'

const same = (entry: string) => entry

describe('searchMentions', () => {
  it('ranks a basename prefix, then a substring, then a subsequence', () => {
    const files = ['docs/the-main-notes.md', 'src/domain.rs', 'src/main.rs', 'web/m-a-i-n.ts', 'README.md']
    expect(searchMentions(files, 'main', same)).toEqual([
      'src/main.rs',
      'docs/the-main-notes.md',
      'src/domain.rs',
      'web/m-a-i-n.ts',
    ])
  })

  it('ignores case and drops what does not match', () => {
    expect(searchMentions(['README.md', 'src/lib.rs'], 'readme', same)).toEqual(['README.md'])
    expect(searchMentions(['a.rs'], 'zz', same)).toEqual([])
  })

  it(`shows at most ${SHOWN}, in the order given when nothing is typed`, () => {
    const many = Array.from({ length: 80 }, (_, n) => `f${n}`)
    expect(searchMentions(many, '', same)).toEqual(many.slice(0, SHOWN))
    expect(searchMentions(many, 'f', same)).toHaveLength(SHOWN)
  })

  it('reads the name it is given', () => {
    const skills = [{ name: 'zeta' }, { name: 'review' }]
    expect(searchMentions(skills, 'rev', (skill) => skill.name)).toEqual([{ name: 'review' }])
  })
})
