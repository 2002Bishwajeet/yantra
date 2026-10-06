import { expect, keyboardWalk, scenario, test } from './lib/test'

/** Y-378: the screenshot budget is small enough that one changed word fails it. */
test('a changed word fails the empty-states baseline', async ({ page, size }, testInfo) => {
  test.skip(size !== 'phone', 'one size is enough to prove the budget')
  // A regenerate run would overwrite the baseline with the altered page.
  test.skip(
    ['all', 'changed'].includes(testInfo.config.updateSnapshots),
    'a regenerate run must not rewrite the baseline',
  )
  await scenario(page, 'empty')
  await page.goto('/fleet')
  await expect(page.getByText('Nothing is running').first()).toBeVisible()
  await keyboardWalk(page, 8)
  await expect(page.locator('.shell__slot')).toHaveCount(0)
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue?.includes('Nothing is running'))
        n.nodeValue = n.nodeValue.replace('Nothing is running', 'Nothing is stopped')
    }
  })
  await expect(
    expect(page).toHaveScreenshot('empty-states-empty-phone.png', { fullPage: true, timeout: 2000 }),
  ).rejects.toThrow()
})
