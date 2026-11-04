import type { Locator, Page } from '@playwright/test'
import type { Size } from './lib/sizes'
import { axe, expect, scenario, screenshot, test } from './lib/test'
import type { Scenario } from './lib/scenario'

/* Y-578: a fresh install, screen by screen. Three things are asserted for every
   destination a new owner can reach: it draws and passes axe (and its
   screenshot is what Y-613 reads), every button on it does something visible,
   and on a 390 px phone no text is cut. `fresh` is the daemon's own state after
   the first join: machines on the tailnet, no check yet, no workspace.

   Left out because each needs a workspace, which a fresh install has none of:
   `/w/<name>`, `/w/<name>/repair`, `/m/<machine>/s/<session>` and `/rooms/<room>`. */

const MACHINES = ['yantra-box', 'macbook', 'pi-5', 'nas']
// Same list as `CATEGORIES` in `screens/settings/categories.tsx`; a new category shows as an unnamed link on /settings.
const CATEGORIES = [
  ['general', 'General'],
  ['notifications', 'Notifications'],
  ['providers', 'Providers'],
  ['agents', 'Agents'],
  ['appearance', 'Appearance'],
  ['about', 'About'],
] as const

type Destination = { id: string; path: string; heading: string | RegExp }

const DESTINATIONS: Destination[] = [
  { id: 'setup', path: '/', heading: 'Set up Yantra' },
  { id: 'fleet', path: '/fleet', heading: 'Fleet' },
  { id: 'machines', path: '/machines', heading: 'Machines' },
  ...MACHINES.map((name) => ({ id: `machine-${name}`, path: `/m/${name}`, heading: name })),
  { id: 'usage', path: '/usage', heading: 'Usage' },
  { id: 'new', path: '/new', heading: 'New session' },
  { id: 'settings', path: '/settings', heading: 'Settings' },
  ...CATEGORIES.map(([id, label]) => ({
    id: `settings-${id}`,
    path: `/settings/${id}`,
    heading: new RegExp(`^(Settings|${label})$`),
  })),
  { id: 'notifications', path: '/notifications', heading: 'Notifications' },
  { id: 'rooms', path: '/rooms', heading: 'Rooms' },
  { id: 'add-device', path: '/machines/add', heading: 'Add a device' },
]

/** What a press visibly does. `url` is the path and search the page ends on, or
 *  an absolute `href` for a link that opens another site (read, not followed).
 *  `dialog` is any dialog on screen; `value` names a text field that fills.
 *  `gone` is text that must no longer be on screen. */
type Rule = {
  kind: 'url' | 'dialog' | 'expanded' | 'pressed' | 'disabled' | 'text' | 'value'
  value: string
  gone?: string
}
type Expect = Rule | Partial<Record<Size, Rule>>

const url = (value: string): Rule => ({ kind: 'url', value })
const dialog: Rule = { kind: 'dialog', value: '' }
const expanded: Rule = { kind: 'expanded', value: 'true' }
const pressed: Rule = { kind: 'pressed', value: 'true' }
const disabled: Rule = { kind: 'disabled', value: '' }
const text = (value: string, gone?: string): Rule => ({ kind: 'text', value, gone })

/** A key names every button whose name starts with it; the longest key wins. */
const SHELL: Record<string, Expect> = {
  Yantra: url('/'),
  Dashboard: url('/'),
  Fleet: url('/fleet'),
  Machines: url('/machines'),
  Usage: url('/usage'),
  'Search anything': expanded,
  Notifications: { phone: url('/notifications'), tablet: expanded, desktop: expanded },
  Account: expanded,
  Back: url('/'),
  'Add a device': url('/machines/add'),
  'New session': url('/new'),
}

// One ready machine ends the checklist, so a check on `/` lands on the dashboard.
const CHECKED: Rule = text('Nothing is running', 'Set up Yantra')
const SETTINGS_NAV = Object.fromEntries(CATEGORIES.map(([id, label]) => [label, url(`/settings/${id}`)]))
const MACHINE_PAGE: Record<string, Expect> = {
  'Check again': text('Ready for sessions', 'Not checked yet'),
  'New session': url('/new'),
  Show: expanded,
}

const PRESSES: Record<string, Record<string, Expect>> = {
  setup: {
    Open: url('/settings/about'),
    'Add a device': url('/machines/add'),
    'Check all': CHECKED,
    Check: CHECKED,
    'New session': url('/new'),
    Connect: url('/settings/providers'),
    'Set up': dialog,
    'Admin console': url('https://login.tailscale.com/admin/machines'),
    'Skip for now': url('/fleet'),
  },
  fleet: { Reorder: disabled, New: url('/new'), 'Sign in': url('/settings/providers') },
  machines: {
    Open: url('/m/yantra-box'),
    'Check again': text('ready'),
    'Add a device': url('/machines/add'),
  },
  ...Object.fromEntries(MACHINES.map((name) => [`machine-${name}`, MACHINE_PAGE])),
  usage: { 'New session': url('/new') },
  new: {
    Close: url('/'),
    Cancel: url('/'),
    'Another name': { kind: 'value', value: 'Name' },
    ...Object.fromEntries(MACHINES.map((name) => [name, pressed])),
    Continue: url('/new?step=2'),
  },
  settings: SETTINGS_NAV,
  'settings-general': SETTINGS_NAV,
  'settings-notifications': { ...SETTINGS_NAV, 'Set up': dialog, Edit: dialog },
  'settings-providers': { ...SETTINGS_NAV, Connect: dialog, Manage: dialog, Edit: dialog },
  'settings-agents': SETTINGS_NAV,
  'settings-appearance': {
    ...SETTINGS_NAV,
    Clean: pressed,
    Compact: pressed,
    ...Object.fromEntries(['brass', 'sage', 'beige', 'terracotta', 'slate', 'plum', 'charcoal'].map((n) => [n, pressed])),
  },
  'settings-about': {
    ...SETTINGS_NAV,
    Source: url('https://github.com/2002Bishwajeet/yantra'),
    'v0.4.0 is out': url('https://github.com/2002Bishwajeet/yantra/releases/tag/v0.4.0'),
    'Update to v': dialog,
  },
  notifications: { Settings: url('/settings/notifications'), 'Mark all read': disabled },
  rooms: {},
  'add-device': {
    Copy: text('Copied'),
    'Show key': dialog,
    'Show QR code': expanded,
    ...Object.fromEntries(['yantra-box', 'pi-5', 'nas'].map((n) => [n, url(`/machines/add?platform=linux&machine=${n}`)])),
  },
}

/** The page has drawn its first reading: its heading is there and no skeleton or reading slot is left. */
async function open(page: Page, name: Scenario, destination: Destination) {
  // A new copy of the state each time, so one press never changes what the next sees.
  await scenario(page, name)
  await page.goto(destination.path)
  await expect(page.locator('h1, h2').filter({ hasText: destination.heading }).first()).toBeAttached()
  await expect(page.locator('[data-slot="reading"], [aria-busy="true"]')).toHaveCount(0)
}

const PRESSABLE = (page: Page) => page.getByRole('button').or(page.getByRole('link'))

type Found = { name: string; scope: 'shell' | 'page' }

/** Name, scope and state of each button and link, in page order. Outside `main` and a dialog is the shell bar. */
function found(all: Locator): Promise<Found[]> {
  return all.evaluateAll((els) =>
    els.map((el) => ({
      name: (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || '')
        .replace(/\s+/g, ' ')
        .trim(),
      scope: el.closest('main, [role="dialog"]') ? ('page' as const) : ('shell' as const),
    })),
  )
}

function lookup(table: Record<string, Expect>, name: string) {
  const keys = Object.keys(table)
    .filter((key) => name.startsWith(key))
    .sort((a, b) => b.length - a.length)
  return keys[0]
}

async function press(page: Page, el: Locator, rule: Rule) {
  if (rule.kind === 'disabled') return expect(el).toBeDisabled()
  if (rule.kind === 'url' && rule.value.startsWith('http')) return expect(el).toHaveAttribute('href', rule.value)
  await el.click()
  switch (rule.kind) {
    case 'url':
      return expect.poll(() => page.url().replace(/^https?:\/\/[^/]+/, '')).toBe(rule.value)
    case 'dialog':
      return expect(page.getByRole('dialog').first()).toBeVisible()
    case 'expanded':
      return expect(el).toHaveAttribute('aria-expanded', rule.value)
    case 'pressed':
      return expect(el).toHaveAttribute('aria-pressed', rule.value)
    case 'value':
      return expect(page.getByRole('textbox', { name: rule.value, exact: true })).not.toHaveValue('')
    case 'text':
      await expect(page.getByText(rule.value, { exact: true }).first()).toBeVisible()
      if (rule.gone) await expect(page.getByText(rule.gone, { exact: true })).toHaveCount(0)
  }
}

/** Press each distinct button once, on a reloaded page, and check what it did.
 *  The table of results goes onto the test, so the report carries the record. */
async function walk(page: Page, size: Size, destination: Destination, name: Scenario = 'fresh') {
  const rows: { scope: string; button: string; expect: Rule; result: string }[] = []
  try {
    await open(page, name, destination)
    const buttons = await found(PRESSABLE(page))
    const tables = { shell: SHELL, page: PRESSES[destination.id]! }
    const unnamed = buttons.filter((b) => lookup(tables[b.scope], b.name) === undefined)
    expect(unnamed, `${destination.path} has buttons the press table does not name`).toEqual([])

    const done = new Set<string>()
    for (const button of buttons) {
      const key = lookup(tables[button.scope], button.name)!
      const id = `${button.scope}/${key}`
      if (done.has(id)) continue
      done.add(id)
      const entry = tables[button.scope][key]!
      const rule = 'kind' in entry ? entry : entry[size]!
      const row = { scope: button.scope, button: button.name, expect: rule, result: 'failed' }
      rows.push(row)
      await open(page, name, destination)
      const now = await found(PRESSABLE(page))
      const index = now.findIndex((one) => one.scope === button.scope && lookup(tables[one.scope], one.name) === key)
      expect(index, `${button.name} is gone after a reload`).toBeGreaterThanOrEqual(0)
      await press(page, PRESSABLE(page).nth(index), rule)
      row.result = 'ok'
    }
  } finally {
    await test.info().attach('presses', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' })
  }
}

/** Text that is wider than its box, or a box that ends past the viewport. A title or an aria-label
 *  excuses nothing: a phone has no hover, so the cut words stay unreadable. */
function clipped(page: Page) {
  return page.evaluate(() => {
    const scrolls = (el: Element) => {
      for (let up: Element | null = el; up && up !== document.body; up = up.parentElement) {
        const overflow = getComputedStyle(up).overflowX
        if (overflow !== 'visible' && up.getBoundingClientRect().right <= innerWidth + 1) return true
      }
      return false
    }
    const out: string[] = []
    for (const el of document.body.querySelectorAll('*')) {
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
      const box = el.getBoundingClientRect()
      if (!own || box.width <= 1 || getComputedStyle(el).visibility === 'hidden') continue
      const cut = el.scrollWidth > el.clientWidth + 1 && !/auto|scroll/.test(getComputedStyle(el).overflowX)
      const past = box.right > innerWidth + 1 && !scrolls(el)
      if (cut || past) {
        out.push(`${cut ? 'cut' : 'past the edge'}: ${el.className} — ${el.textContent?.trim().slice(0, 60)}`)
      }
    }
    return out
  })
}

for (const destination of DESTINATIONS) {
  test.describe(`a fresh install at ${destination.path}`, () => {
    test('draws, passes axe and is captured', async ({ page, size }) => {
      await open(page, 'fresh', destination)
      // The page draws a random name; a fixed one keeps the capture the same each run.
      if (destination.id === 'new') await page.getByLabel('Name').fill('quiet-otter')
      await axe(page)
      await screenshot(page, destination.id, 'fresh', size)
    })

    test('answers every button', async ({ page, size, context }) => {
      test.setTimeout(240_000)
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await walk(page, size, destination)
    })

    test('cuts no text on a phone', async ({ page, size }) => {
      test.skip(size !== 'phone', 'the phone is the narrowest size')
      await open(page, 'fresh', destination)
      expect(await clipped(page)).toEqual([])
    })
  })
}

// #514, before Y-579: a re-check of a machine no workspace names was refused. `freshdefect` brings that back,
// and the walk must fail on it. `test.fail` turns red the day the walk stops seeing the defect.
for (const path of ['/machines', '/m/macbook']) {
  const destination = DESTINATIONS.find((one) => one.path === path)!
  test(`the walk catches #514 at ${path}`, async ({ page, size, context }) => {
    test.fail()
    test.setTimeout(240_000)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await walk(page, size, destination, 'freshdefect')
  })
}
