import { axe, expect, scenario, test } from './lib/test'

/** Y-498: the Chat's drawer opens a shell in the thread's worktree. The
 *  fixture answers the POST as write.rs does and attaches the session socket. */
const NAME = 'yantra-web'
const THREAD = '1a2b3c4d'
const SESSION = `yantra-term-${NAME}-${THREAD}`

test.beforeEach(async ({ page }) => {
  await scenario(page, 'busy')
})

test('holds the toggle until the first turn makes a thread', async ({ page }) => {
  await page.goto(`/w/${NAME}`)
  const toggle = page.getByRole('button', { name: 'Terminal', exact: true })
  await expect(toggle).toHaveAttribute('aria-disabled', 'true')
  await expect(toggle).toHaveAccessibleDescription("The terminal opens in the thread's worktree, which the first turn makes.")
})

test('opens a shell in the worktree, passes axe, and Close puts focus back', async ({ page, size }) => {
  await page.goto(`/w/${NAME}?thread=${THREAD}`)
  await expect(page.getByText('Is the core crate green?')).toBeVisible()
  const toggle = page.getByRole('button', { name: 'Terminal', exact: true })
  await toggle.click()

  const drawer = page.getByRole('complementary', { name: "Terminal in the thread's worktree" })
  await expect(drawer.getByRole('status')).toContainText(`attached · tmux ${SESSION} on `)
  await expect(drawer).toContainText("share the thread's worktree")
  await expect(drawer.getByRole('toolbar', { name: 'Keys' })).toHaveCount(size === 'phone' ? 1 : 0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await axe(page)

  await drawer.getByRole('button', { name: 'Close' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(toggle).toBeFocused()
})
