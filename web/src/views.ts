/** The three views of `/w/{name}` — chat first (M14 board 13), then D5 §3.1's
 *  terminal and spend, where `repair` is deliberately not a fourth. The transcript
 *  is the Terminal's History since Y-633. Its own module because
 *  `router.ts` validates the search param and the session screen draws the
 *  bar, and `router.ts` importing the screen would pull xterm.js into the
 *  first load. */
export const VIEWS = ['chat', 'terminal', 'spend'] as const

export type View = (typeof VIEWS)[number]

/** An unknown `?view=` is no view rather than a 404: the workspace is real and
 *  the page can draw. The width then decides, as it does when the URL says
 *  nothing (D5 §3.3). */
export const asView = (given: unknown): View | undefined =>
  // An old link to ?view=transcript still lands, on the view that now holds it.
  given === 'transcript' ? 'terminal' : VIEWS.find((one) => one === given)
