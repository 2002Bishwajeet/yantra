import { expect, scenario, test } from './lib/test'
import type { Page } from '@playwright/test'

/** The chat flows the unit tests cannot reach (Y-484): they need a real
 *  mounted Session, a second tab, or a reload. The fixture's chat socket acts
 *  as chat.rs does for each. */
const NAME = 'yantra-web'
const PATH = `/w/${NAME}`
const THREAD = '1a2b3c4d'

const views = (page: Page) => page.getByRole('navigation', { name: 'Views' })
const asking = (page: Page) => page.getByText('Claude asks to run')
const composer = (page: Page, size: string) =>
  page.getByLabel(size === 'phone' ? 'Message Claude' : `Message Claude in ${NAME}`, { exact: true })

async function send(page: Page, size: string) {
  await composer(page, size).fill('run the core tests')
  await page.getByRole('button', { name: 'Send' }).click()
}

async function turn(page: Page, size: string) {
  await send(page, size)
  await expect(asking(page)).toBeVisible()
}

async function fullAccess(page: Page) {
  await page.getByRole('button', { name: /^Permissions: / }).click()
  await page.getByRole('menuitemradio', { name: 'Full access' }).click()
  await expect(page.getByRole('button', { name: 'Permissions: Full access' })).toBeVisible()
}

test.describe('the chat, across views, tabs and reloads', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'busy')
    await page.goto(PATH)
    await expect(page.getByRole('heading', { level: 1, name: NAME }).first()).toBeVisible()
  })

  test('Terminal and back keeps a turn running', async ({ page, size }) => {
    await turn(page, size)
    await views(page).getByRole('link', { name: 'Terminal' }).click()
    await expect(views(page).getByRole('link', { name: 'Terminal' })).toHaveAttribute('aria-current', 'page')
    await views(page).getByRole('link', { name: 'Chat' }).click()

    await expect(asking(page)).toBeVisible()
    await expect(page.getByRole('status')).toHaveText('Claude is waiting for your answer.')
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
  })

  test('a second tab cannot revert during a turn', async ({ page, size }) => {
    await turn(page, size)
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
    const revert = page.getByRole('button', { name: 'Revert to before this turn' })
    await expect(revert).toBeVisible()

    const other = await page.context().newPage()
    await other.goto(`${PATH}?thread=${THREAD}`)
    await expect(other.getByText('Is the core crate green?')).toBeVisible()
    await turn(other, size)

    await revert.click()
    await page
      .getByRole('dialog', { name: 'Revert to before turn 1?' })
      .getByRole('button', { name: 'Revert', exact: true })
      .click()
    await expect(page.getByRole('alert')).toContainText(
      'another tab is running a turn or a revert in this thread',
    )
    await expect(page.getByText('Reverted')).toHaveCount(0)

    await other.getByRole('button', { name: 'Stop Claude' }).click()
    await expect(other.getByRole('status')).toHaveText('Claude stopped.')
    await revert.click()
    await page
      .getByRole('dialog', { name: 'Revert to before turn 1?' })
      .getByRole('button', { name: 'Revert', exact: true })
      .click()
    await expect(page.getByText('Reverted')).toBeVisible()
  })

  test('Full access draws no permission card', async ({ page, size }) => {
    await fullAccess(page)
    await send(page, size)
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
    await expect(asking(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
    await page.getByText('Output').click()
    await expect(page.getByText('test result: ok')).toBeVisible()
  })

  test('the mode survives a reload', async ({ page, size }) => {
    await fullAccess(page)
    await send(page, size)
    await expect(page).toHaveURL(new RegExp(`thread=${THREAD}`))
    await expect(page.getByRole('status')).toHaveText('Claude finished.')
    await page.reload()
    await expect(page.getByRole('button', { name: 'Permissions: Full access' })).toBeVisible()
  })
})
