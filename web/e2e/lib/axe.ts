import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/** Run axe on the page as it is and fail on any violation, with each one
 *  named and located. `known` lists violation ids the page is known to carry:
 *  those are asserted *present*, so the test stays green while the debt
 *  stands and fails the day a fix lands without the list being edited. */
export async function axe(page: Page, options: { known?: string[] } = {}) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const known = results.violations.filter((v) => options.known?.includes(v.id))
  const unknown = results.violations.filter((v) => !options.known?.includes(v.id))

  expect(
    unknown.map((v) => v.id),
    `axe found ${unknown.length} violation(s):\n\n${report(unknown)}`,
  ).toEqual([])

  for (const violation of known) {
    test.info().annotations.push({ type: 'known', description: `axe: ${violation.id}` })
  }
  expect(
    known.map((v) => v.id).sort(),
    'a known axe violation is gone: remove it from `known`',
  ).toEqual([...(options.known ?? [])].sort())
  return results
}

function report(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']) {
  return violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map(
          (n) =>
            `  - ${n.target.join(' ')}\n    ${n.html.slice(0, 160)}\n    ${n.failureSummary?.replace(/\n/g, '\n    ')}`,
        )
        .join('\n')
      const more = v.nodes.length > 5 ? `\n  … and ${v.nodes.length - 5} more` : ''
      return `${v.id} (${v.impact}): ${v.help}\n  ${v.helpUrl}\n${nodes}${more}`
    })
    .join('\n\n')
}
