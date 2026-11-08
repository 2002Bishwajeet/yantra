import type { Page } from '@playwright/test'

/** Y-670: the phone shell scrolls `.shell__main`; the tablet and desktop scroll the document.
 *  The element is picked by what is on the page, so a test never asks which size it runs at. */
export const scrollTo = (page: Page, to: number | 'end') =>
  page.evaluate((y) => {
    const el = document.querySelector('[data-shell="phone"] .shell__main') ?? document.scrollingElement!
    el.scrollTo(0, y === 'end' ? el.scrollHeight : y)
  }, to)

/** Rounded px between the scroller's last row and the foot of its view; 0 once scrolled to the end. */
export const endGap = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-shell="phone"] .shell__main') ?? document.scrollingElement!
    return Math.round(el.scrollTop + el.clientHeight - el.scrollHeight)
  })

export const scrollHeight = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-shell="phone"] .shell__main') ?? document.scrollingElement!).scrollHeight)
