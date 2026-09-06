import { test as base } from '@playwright/test'
import type { Size } from './sizes'

/** `test` with a `size` fixture naming the project the test runs under —
 *  the third part of a screenshot's name. */
export const test = base.extend<{ size: Size }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright's fixture signature
  size: async ({}, provide, testInfo) => {
    await provide(testInfo.project.name as Size)
  },
})

export { expect } from '@playwright/test'
export { axe } from './axe'
export { keyboardWalk } from './keyboard'
export { firstReading, scenario } from './scenario'
export { screenshot } from './screenshot'
export { at } from './sizes'
