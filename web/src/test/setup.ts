import { afterEach } from 'vitest'
import { cleanup, configure } from '@testing-library/react'

// React's act() warning fires without this flag under a runner React does not
// know, and every component test unmounts what it drew.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

// A `findBy` races a lazy chunk's transform; on a loaded box or a CI runner
// one second loses. Four is still short enough to fail a real hang.
configure({ asyncUtilTimeout: 4000 })
