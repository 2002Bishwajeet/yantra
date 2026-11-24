import { afterEach } from 'vitest'
import { cleanup, configure } from '@testing-library/react'
import { guardCapitals } from './capitals'

// React's act() warning fires without this flag under a runner React does not
// know, and every component test unmounts what it drew.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)
// After `cleanup` here, so it runs first and still reads the page: Vitest runs `afterEach` hooks last to first.
guardCapitals()

// A `findBy` races a lazy chunk's transform; on a loaded box or a CI runner
// one second loses. Ten is still short enough to fail a real hang, and a green run never waits for it.
//
// `[data-live]` is the shell's live region (m3/live/), which holds a copy of a
// sentence the screen under it already draws. The copy is for a reader, not
// for a query, so a text query that would otherwise find the same words twice
// skips it.
configure({ asyncUtilTimeout: 10_000, defaultIgnore: 'script, style, [data-live]' })
