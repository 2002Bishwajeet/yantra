import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { route } from './lib/routes'

/** `/w/price-table/repair` (Y-351) on the `repair` scenario, where the file
 *  is the Repair board's: fourteen lines, `machine` commented out at line 7.
 *  The two refusals are ADR-0020's, and the fixture words them as write.rs
 *  does. */
const PATH = route('repair').path

// The phone's app bar is a second h1 over the screen's hidden one.
const heading = (page: Parameters<typeof axe>[0], name: string) =>
  page.getByRole('heading', { level: 1, name }).first()

test.describe('repair on a file that will not load', () => {
  test.beforeEach(async ({ page }) => {
    await scenario(page, 'repair')
    await page.goto(PATH)
    await expect(heading(page, 'Repair price-table')).toBeVisible()
    await expect(page.getByLabel('The file')).toBeVisible()
  })

  test('draws the board: path, chip, error, the numbered file and its marked line', async ({ page }) => {
    await expect(
      page.getByText('/home/biswa/.config/yantra/workspaces/price-table.toml', { exact: true }),
    ).toBeVisible()
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('will not load')
    await expect(alert.getByRole('heading', { name: 'price-table will not load.' })).toBeVisible()
    await expect(alert).toContainText("missing field 'machine' at line 7")
    await expect(page.getByText('14 lines')).toBeVisible()
    await expect(page.getByText('Three keys load:')).toBeVisible()

    const file = page.getByLabel('The file')
    await expect(file).toHaveValue(/^# price-table\n/)
    await expect(file).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('.repair__gutter [data-error]')).toHaveText('7')
    await expect(page.locator('.repair__line[data-error] .repair__marker')).toHaveText("missing field 'machine'")

    await expect(page.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/w/price-table')
  })

  test('passes axe', async ({ page }) => {
    await axe(page)
  })

  test('walks by keyboard', async ({ page }) => {
    await keyboardWalk(page, 8)
  })

  test('looks like the board', async ({ page, size }) => {
    await screenshot(page, 'repair', 'repair', size)
  })

  test('a save that still will not load is refused, and the text stays', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'one size is enough for the wire')
    const file = page.getByLabel('The file')
    const typed = '# price-table\nrepo = "/home/biswa/Github/price-table"\n'
    await file.fill(typed)
    await expect(page.getByText('2 lines')).toBeVisible()
    await page.getByRole('button', { name: 'Save' }).click()

    const alert = page.getByRole('alert')
    await expect(alert.getByRole('heading', { name: 'Those bytes still will not load.' })).toBeVisible()
    await expect(alert).toContainText('missing field `machine` at line 7')
    await expect(file).toHaveValue(typed)
    await expect(page).toHaveURL(PATH)
    await screenshot(page, 'repair-refused', 'repair', size)
  })

  test('a save that loads opens the workspace', async ({ page, size }) => {
    test.skip(size !== 'desktop', 'one size is enough for the wire')
    const file = page.getByLabel('The file')
    await file.fill('machine = "cachyos-g14"\nrepo = "/home/biswa/Github/price-table"\n')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveURL('/w/price-table')
  })
})

test('repair on a file that loads is refused, and links to the workspace', async ({ page }) => {
  await scenario(page, 'busy')
  await page.goto(PATH)
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('That file loads, so there is nothing to repair.')
  await expect(alert).toContainText('loads, so its file may not be written whole')
  await expect(page.getByRole('link', { name: 'Open price-table' })).toHaveAttribute('href', '/w/price-table')
  await expect(page.getByLabel('The file')).toHaveCount(0)
  await axe(page)
})
