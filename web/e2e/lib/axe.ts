import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/** Run axe on the page as it is and fail on any violation, with each one
 *  named and located. `known` lists violation ids the page is known to carry:
 *  those mark the test `fixme` by id instead of failing, so the debt stays
 *  visible and named until the page is fixed. */
export async function axe(page: Page, options: { known?: string[] } = {}) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const known = results.violations.filter((v) => options.known?.includes(v.id))
  const unknown = results.violations.filter((v) => !options.known?.includes(v.id))

  expect(
    unknown.map((v) => v.id),
    `axe found ${unknown.length} violation(s):\n\n${report(unknown)}`,
  ).toEqual([])

  for (const violation of known) {
    test.info().annotations.push({ type: 'fixme', description: `axe: ${violation.id}` })
  }
  test.fixme(known.length > 0, `axe: ${known.map((v) => v.id).join(', ')}`)
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
