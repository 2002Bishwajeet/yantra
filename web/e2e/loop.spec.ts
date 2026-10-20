import { axe, expect, scenario, test } from './lib/test'
import { route } from './lib/routes'

/** The coding loop (Y-489): an inbox issue to a thread in Chat. The fixture
 *  answers the daemon's `threads`, `threads/new` and `placement` routes. */
const ISSUE = '2002Bishwajeet/yantra#118'
const THREAD = '1a2b3c4d'

test('an inbox issue starts a session with its draft and lists the threads', async ({ page, size }) => {
  await scenario(page, 'busy')
  await page.goto(route('fleet').path)
  await page.getByRole('button', { name: `Start session on ${ISSUE}` }).click()

  const dialog = page.getByRole('dialog', { name: `Start a session on ${ISSUE}` })
  const list = dialog.getByRole('list', { name: 'Workspaces that hold this repository' })
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('cachyos-g14')
  await expect(list).toContainText('it is idle and it has RAM to spare')
  await axe(page)

  await list.getByRole('button', { name: 'yantra-web' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/yantra-web\\?.*thread=${THREAD}`))
  // The draft is in router state, so the issue text is not in the address.
  expect(page.url()).not.toContain('Work')

  const composer = page.getByLabel(size === 'phone' ? 'Message Claude' : 'Message Claude in yantra-web', { exact: true })
  await expect(composer).toHaveValue(/^Work on /)

  const threads = page.getByRole('region', { name: 'Threads' })
  await expect(threads.getByRole('link')).toHaveCount(5)
  await expect(threads.locator('a[aria-current]')).toHaveCount(1)
  for (const mark of ['no PR', 'PR #512 open', 'PR #511 closed', 'PR #510 merged', 'PR unknown']) {
    await expect(threads.getByText(mark)).toBeVisible()
  }
  await expect(threads.getByText('2002Bishwajeet/yantra#488')).toBeVisible()
})
