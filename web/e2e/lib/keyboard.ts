import { expect, type Page } from '@playwright/test'

export type Stop = {
  element: string
  name: string
  indicator: string
  visible: boolean
  /** Base UI's focus-trap sentinel, which takes a Tab and hands it straight
   *  on. It is `aria-hidden` and one pixel wide, so it is not a stop. */
  guard?: boolean
}

/** Tab through the first `n` stops. Every one must be on screen, carry an
 *  accessible name, and show a focus indicator — a computed outline or box
 *  shadow, since Chromium applies `:focus-visible` to a Tab. Stops early when
 *  focus leaves the document, and fails if nothing took it at all. */
export async function keyboardWalk(page: Page, n: number): Promise<Stop[]> {
  const stops: Stop[] = []
  for (let presses = 0; stops.length < n && presses < n * 2; presses++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(inspect)
    if (!stop) break
    if (!stop.guard) stops.push(stop)
  }

  expect(stops.length, 'nothing on the page took focus').toBeGreaterThan(0)
  const bad = stops.filter((s) => !s.visible || !s.name || s.indicator === 'none')
  expect(
    bad,
    `keyboard walk: ${bad.length} of ${stops.length} stops fail\n${stops
      .map(
        (s, i) =>
          `  ${i + 1}. ${s.element} name=${JSON.stringify(s.name)} indicator=${s.indicator}${s.visible ? '' : ' OFFSCREEN'}`,
      )
      .join('\n')}`,
  ).toEqual([])
  return stops
}

// Runs in the page. Kept to what the walk asserts, not an accessible-name
// algorithm: aria-label, labelledby, a form label, text, title, placeholder.
function inspect(): Stop | null {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return null
  if (el.hasAttribute('data-base-ui-focus-guard'))
    return { element: 'guard', name: '', indicator: 'none', visible: false, guard: true }

  const byId = (ids: string | null) =>
    (ids ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .join(' ')
      .trim()
  const labels = (el as HTMLInputElement).labels
  const name =
    el.getAttribute('aria-label')?.trim() ||
    byId(el.getAttribute('aria-labelledby')) ||
    (labels && labels[0]?.textContent?.trim()) ||
    el.textContent?.replace(/\s+/g, ' ').trim() ||
    el.getAttribute('title')?.trim() ||
    el.getAttribute('placeholder')?.trim() ||
    el.querySelector('img[alt]')?.getAttribute('alt')?.trim() ||
    ''

  const style = getComputedStyle(el)
  const transparent = (c: string) => c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c)
  const outline =
    style.outlineStyle !== 'none' &&
    parseFloat(style.outlineWidth) > 0 &&
    !transparent(style.outlineColor)
  const shadow = style.boxShadow !== 'none'
  const indicator = outline
    ? `outline ${style.outlineWidth} ${style.outlineStyle}`
    : shadow
      ? `box-shadow ${style.boxShadow.slice(0, 40)}`
      : 'none'

  const box = el.getBoundingClientRect()
  const visible =
    box.width > 0 &&
    box.height > 0 &&
    style.visibility !== 'hidden' &&
    box.bottom > 0 &&
    box.right > 0 &&
    box.top < innerHeight &&
    box.left < innerWidth

  const role = el.getAttribute('role')
  const element = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${role ? `[role=${role}]` : ''}`
  return { element, name, indicator, visible }
}
