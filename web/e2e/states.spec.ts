import { axe, expect, keyboardWalk, scenario, screenshot, test } from './lib/test'
import { ROUTES, type RouteId } from './lib/routes'

/** Y-351: every route on every error and empty scenario. What each route
 *  owes is written here as words from the EmptyStates, Unreachable and
 *  WorkspaceNotFound boards; a screen that does not draw them yet is `fixme`
 *  under its own row, and turns green as it lands. */

/** What a route draws on `empty`, or null where no board has a block. */
const EMPTY: Record<RouteId, readonly string[] | null> = {
  dashboard: ['Nothing needs you', 'Nothing is running', 'no workspaces yet'],
  fleet: ['Nothing needs you', 'Nothing is running', 'no workspaces yet'],
  machines: ['every tmux session on the machines that answered belongs to a workspace'],
  machine: null,
  'session-terminal': null,
  usage: ['No spend yet'],
  session: ['No workspace is called landing.', 'The fleet lists the ones there are.'],
  repair: ['No workspace is called price-table.', 'The fleet lists the ones there are.'],
  new: null,
  settings: null,
  'settings-category': null,
  notifications: ['Nothing unread.'],
}

/** What `unreachable` does to a route: `page` is the Unreachable board with
 *  Try again; `missing` is a name the fixture cannot find once the workspace
 *  list fails, which is not worth asking twice; `none` reads nothing swept. */
const UNREACHABLE: Record<RouteId, 'page' | 'missing' | 'none'> = {
  dashboard: 'page',
  fleet: 'page',
  machines: 'page',
  machine: 'page',
  'session-terminal': 'page',
  usage: 'page',
  session: 'page',
  repair: 'missing',
  new: 'page',
  settings: 'none',
  'settings-category': 'none',
  // The ring buffer is the daemon's own memory; a failed attention read
  // only leaves the GitHub items out (shell/useEntries.ts).
  notifications: 'none',
}

/** `broken` overlays `/api/machines` with a body missing its `data`: every
 *  route that reads machines meets the contract surface. */
const READS_MACHINES: readonly RouteId[] = ['dashboard', 'fleet', 'machines', 'machine', 'new']

/** The write each route offers on `busy`, for `refused`. Only the verbs the
 *  boards name; a screen with none is not asked. */
const WRITES: Partial<Record<RouteId, string>> = {
  dashboard: 'Start',
  fleet: 'Start',
  // Every workspace on cachyos-g14 is past its first start, so the verb the
  // machine page offers is Resume rather than Start.
  machine: 'Resume',
}

// write.rs `Refused::NotYours`, as refused.json carries it.
const REFUSAL = 'node biswas-iphone is on this tailnet but is not yours'

/** The three boards this row owns that are states of a route rather than
 *  screens of their own. Each is a picture at every size; the rest of the
 *  sweep only asserts, because a screenshot of a screen another row is still
 *  writing goes stale the same afternoon. */
const BOARDS = {
  unreachable: { id: 'fleet', name: 'unreachable' },
  empty: { id: 'fleet', name: 'empty-states' },
  missing: { id: 'session', name: 'workspace-not-found' },
} as const satisfies Record<string, { id: RouteId; name: string }>

type Case = 'unreachable' | 'empty' | 'held' | 'broken' | 'flaky' | 'refused'

/** Cases whose screens have not landed. A row with no `cases` is `fixme`
 *  everywhere; the sweep is re-run to move a row out as it turns green. */
const PENDING: Partial<Record<RouteId, { row: string; why: string; cases?: readonly Case[] }>> = {
  dashboard: { row: 'Y-346', why: 'the Dashboard is still being written', cases: ['refused'] },
  fleet: { row: 'Y-347', why: 'a machines body without `data` is swallowed', cases: ['broken'] },
  session: { row: 'Y-348', why: 'no page-level Try again on the Session screen', cases: ['unreachable', 'flaky'] },
  'session-terminal': {
    row: 'Y-348',
    why: 'the machine link in the status line fails link-in-text-block, and nothing draws a skeleton',
    cases: ['unreachable', 'held'],
  },
  new: { row: 'Y-349', why: 'no page-level Try again on New session', cases: ['unreachable', 'flaky'] },
}

const pending = (id: RouteId, which: Case) => {
  const one = PENDING[id]
  const held = one !== undefined && (one.cases === undefined || one.cases.includes(which))
  test.fixme(held, `${one?.row}: ${one?.why}`)
}

for (const one of ROUTES) {
  test.describe(`${one.path} states`, () => {
    test(`on unreachable: ${UNREACHABLE[one.id]}`, async ({ page, size }) => {
      const kind = UNREACHABLE[one.id]
      test.skip(kind === 'none', 'reads nothing the tailnet answers')
      pending(one.id, 'unreachable')
      await scenario(page, 'unreachable')
      await page.goto(one.path)
      const alert = page.getByRole('alert').first()
      await expect(alert).toBeVisible()
      if (kind === 'page') {
        await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible()
      }
      await axe(page)
      if (one.id === BOARDS.unreachable.id) {
        await keyboardWalk(page, 8)
        await screenshot(page, BOARDS.unreachable.name, 'unreachable', size)
      }
    })

    test("on empty: the board's words", async ({ page, size }) => {
      const words = EMPTY[one.id]
      test.skip(words === null, 'no board draws an empty block here')
      pending(one.id, 'empty')
      await scenario(page, 'empty')
      await page.goto(one.path)
      for (const word of words ?? []) {
        await expect(page.getByText(word).first()).toBeVisible()
      }
      await axe(page)
      for (const board of [BOARDS.empty, BOARDS.missing]) {
        if (one.id !== board.id) continue
        await keyboardWalk(page, 8)
        await screenshot(page, board.name, 'empty', size)
      }
    })

    test('on busy, held: a skeleton and never a flash of empty', async ({ page, size }) => {
      test.skip(size !== 'desktop', 'the wire is the same at every size')
      test.skip(UNREACHABLE[one.id] === 'none', 'reads nothing swept')
      pending(one.id, 'held')
      await scenario(page, 'busy', { slow: 1500 })
      await page.goto(one.path)
      const skeleton = page.locator('[data-slot="skeleton"]')
      await expect(skeleton.first()).toBeVisible()
      for (const word of EMPTY[one.id] ?? []) {
        await expect(page.getByText(word)).toHaveCount(0)
      }
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(skeleton).toHaveCount(0, { timeout: 15_000 })
    })

    test('on broken: the contract surface', async ({ page, size }) => {
      test.skip(size !== 'desktop', 'the wire is the same at every size')
      test.skip(!READS_MACHINES.includes(one.id), 'does not read machines')
      pending(one.id, 'broken')
      await scenario(page, 'broken')
      await page.goto(one.path)
      await expect(page.getByRole('alert').first()).toBeVisible()
      await axe(page)
    })

    test('on flaky: Try again recovers', async ({ page, size }) => {
      test.skip(size !== 'desktop', 'the wire is the same at every size')
      test.skip(UNREACHABLE[one.id] !== 'page', 'no page-level surface to recover from')
      pending(one.id, 'flaky')
      await scenario(page, 'flaky')
      await page.goto(one.path)
      const again = page.getByRole('button', { name: 'Try again' }).first()
      await expect(again).toBeVisible()
      await again.click()
      await expect(page.getByRole('alert')).toHaveCount(0)
    })

    test("on refused: a write shows the daemon's text", async ({ page, size }) => {
      test.skip(size !== 'desktop', 'the wire is the same at every size')
      const verb = WRITES[one.id]
      test.skip(verb === undefined, 'no verb on this board')
      pending(one.id, 'refused')
      await scenario(page, 'refused')
      await page.goto(one.path)
      await page.getByRole('button', { name: verb, exact: true }).first().click()
      await expect(page.getByRole('alert').filter({ hasText: REFUSAL }).first()).toBeVisible()
    })
  })
}
