import { chromium } from '/nm/playwright-core/index.mjs'

const browser = await chromium.launch()

// The banner ships at 2x for a sharp <img> on a retina screen; the social
// preview is GitHub's fixed 1280x640, so it stays at 1x.
const banner = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })
await banner.goto('file:///work/design/brand/cards.html')
await banner.evaluate(() => document.fonts.ready)
await banner.waitForTimeout(300)
await banner.locator('#readme-b2').screenshot({ path: '/work/design/brand/readme-banner.png' })

const social = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 })
await social.goto('file:///work/design/brand/cards.html')
await social.evaluate(() => document.fonts.ready)
await social.waitForTimeout(300)
await social.locator('#gh-a1').screenshot({ path: '/work/design/brand/social-preview.jpg', type: 'jpeg', quality: 90 })

await browser.close()
