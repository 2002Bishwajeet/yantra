import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// React's act() warning fires without this flag under a runner React does not
// know, and every component test unmounts what it drew.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)
