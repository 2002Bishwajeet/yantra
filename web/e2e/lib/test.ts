import { test as base } from '@playwright/test'
import type { Size } from './sizes'

/** `test` with a `size` fixture naming the project the test runs under —
 *  the third part of a screenshot's name. */
export const test = base.extend<{ size: Size }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright's fixture signature
  size: async ({}, provide, testInfo) => {
    await provide((testInfo.project.metadata.size ?? testInfo.project.name) as Size)
  },
})

export { expect } from '@playwright/test'

/** The first run in WebKit found it: an iPhone gets a tailscale.com/download link that axe and the press table refuse. */
export const IPHONE_ADD_DEVICE = 'Y-684: Add a device on an iPhone draws a link that fails axe link-in-text-block'
export { axe } from './axe'
export { keyboardWalk } from './keyboard'
export { firstReading, scenario } from './scenario'
export { screenshot } from './screenshot'
export { at } from './sizes'
