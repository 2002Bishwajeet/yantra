import { afterEach, expect } from 'vitest'

/** The second line of a list row, the lines Setup and a Machines card draw under a name, their chips,
 *  and the state word of a Fleet, Machine or Machines session row. */
const LINES = [
  '.m3-list-item__supporting',
  '.m3-row__supporting',
  '.setup__sub > .m3-text',
  '.m3-text.setup__said',
  '.setup__said > .m3-text',
  '.machines__about',
  '.machines__summary',
  '.machines__detail',
  '.machines__head .m3-chip',
  '.m3-list-item__trailing .m3-chip',
  '.fleet__state',
  '.machine__state',
  '.machines__session .m3-state',
  '.machine__where',
].join(', ')

/** A product or a tool that is spelled in lower case, a host or an address, a hyphenated host, and a
 *  name before a colon (a workspace's `api: …` or a commit's `feat: …`). */
const NAME = /^(?:macOS|iOS|gh|git|claude|ssh|tmux)\b|^[\w-]+\.\S|^[a-z\d]+(?:-[a-z\d]+)+\b|^[\w-]+: /

/** Where a page shows a machine's name: a line may start with that name. */
const MACHINES = '.setup__machine, .machines__card h2'

/** A line that starts inside `[data-name]` starts with a name or with a person's own words. */
function startsInName(line: Element) {
  const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node.textContent?.trim()) return node.parentElement?.closest('[data-name]') != null
  }
  return false
}

/** The supporting lines under `root` that start in lower case. */
export function lowerLines(root: ParentNode): string[] {
  const machines = new Set([...root.querySelectorAll(MACHINES)].map((one) => one.textContent ?? ''))
  return [...root.querySelectorAll(LINES)]
    .filter((one) => !startsInName(one))
    .map((one) => (one.textContent ?? '').trim())
    .filter((line) => /^\p{Ll}/u.test(line) && !NAME.test(line) && !machines.has(line.split(' ')[0]!))
}

/** Y-763: fails a test that drew a supporting line in lower case. It reads the page and not the
 *  source, so it sees a computed line, and it reads every change, so it sees a line that came and went. */
export function guardCapitals() {
  if (typeof document === 'undefined') return
  const seen = new Set<string>()
  const scan = () => {
    if (typeof document === 'undefined') return
    for (const line of lowerLines(document)) seen.add(line)
  }
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true })
  afterEach(() => {
    scan()
    const lower = [...seen]
    seen.clear()
    expect(lower, 'supporting lines that start in lower case').toEqual([])
  })
}
