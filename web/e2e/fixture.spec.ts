import { expect, test } from '@playwright/test'
import { FIXTURE_PORT } from './lib/sizes'

/** The fixture daemon itself: each scenario does what its name says, and a
 *  write is a fact the next read agrees with. Straight to the fixture's port
 *  with the header, so this is also the way a test outside a page picks one. */
const api = `http://127.0.0.1:${FIXTURE_PORT}/api`

/** A test id is the same on every run, and the fixture keeps what a write
 *  left behind, so a reused server (`reuseExistingServer`) would answer the
 *  second run from the first run's state. One word per run keys them apart. */
const RUN = Math.random().toString(36).slice(2, 8)
const under = (scenario: string) => ({
  headers: { 'x-fixture-scenario': `${scenario}#${test.info().testId}-${RUN}` },
})

test('busy lists the brief\'s six machines and ten workspaces', async ({ request }) => {
  const machines = await (await request.get(`${api}/machines`, under('busy'))).json()
  expect(machines.data.map((m: { name: string }) => m.name)).toEqual([
    'cachyos-g14', 'macbook', 'pi-5', 'hetzner-1', 'nas', 'thinkpad',
  ])
  const workspaces = await (await request.get(`${api}/workspaces`, under('busy'))).json()
  expect(workspaces.data).toHaveLength(10)
})

test('a create is on the next read, and only for the test that made it', async ({ request }) => {
  const made = await request.post(`${api}/workspaces`, {
    ...under('busy'),
    data: { name: 'fresh', machine: 'pi-5', repo: '/home/biswa/fresh', startup: null },
  })
  expect(made.status()).toBe(201)
  const mine = await (await request.get(`${api}/workspaces`, under('busy'))).json()
  expect(mine.data.map((w: { name: string }) => w.name)).toContain('fresh')
  const status = await (await request.get(`${api}/workspaces/fresh/status`, under('busy'))).json()
  expect(status.data.status).toEqual({ state: 'no_session' })

  const theirs = await (
    await request.get(`${api}/workspaces`, { headers: { 'x-fixture-scenario': 'busy#other' } })
  ).json()
  expect(theirs.data).toHaveLength(10)
})

test('empty has the machines and no workspace', async ({ request }) => {
  const workspaces = await (await request.get(`${api}/workspaces`, under('empty'))).json()
  expect(workspaces.data).toEqual([])
  const machines = await (await request.get(`${api}/machines`, under('empty'))).json()
  expect(machines.data).toHaveLength(6)
})

test('unreachable fails every read the same way', async ({ request }) => {
  for (const path of ['machines', 'workspaces', 'sessions', 'attention', 'workspaces/x/status']) {
    const read = await (await request.get(`${api}/${path}`, under('unreachable'))).json()
    expect(read.looked, path).toBe('failed')
  }
})

test('nogrant reads the fleet and not GitHub', async ({ request }) => {
  const attention = await (await request.get(`${api}/attention`, under('nogrant'))).json()
  expect(attention.looked).toBe('failed')
  expect(attention.error).toContain('no GitHub grant')
  const github = await (await request.get(`${api}/readiness/github`, under('nogrant'))).json()
  expect(github.data.state).toBe('absent')
})

test('refused reads, and answers every write 403 with the daemon\'s text', async ({ request }) => {
  const read = await request.get(`${api}/workspaces`, under('refused'))
  expect(read.status()).toBe(200)
  const write = await request.post(`${api}/workspaces/yantra-web/up`, under('refused'))
  expect(write.status()).toBe(403)
  // write.rs `Refused::NotYours`, word for word.
  expect(await write.text()).toBe('node biswas-iphone is on this tailnet but is not yours')
})

test('flaky fails each read once with a 502, then answers it', async ({ request }) => {
  const statuses = []
  for (const path of ['machines', 'machines', 'workspaces', 'workspaces', 'machines']) {
    statuses.push((await request.get(`${api}/${path}`, under('flaky'))).status())
  }
  expect(statuses).toEqual([502, 200, 502, 200, 200])
})

test('broken answers /api/machines and /api/github with bodies missing their fields', async ({ request }) => {
  const machines = await (await request.get(`${api}/machines`, under('broken'))).json()
  expect(machines).toEqual({ looked: 'ok', age_seconds: 0 })
  const github = await (await request.get(`${api}/github`, under('broken'))).json()
  expect(github).toEqual({})
  const workspaces = await (await request.get(`${api}/workspaces`, under('broken'))).json()
  expect(workspaces.data).toHaveLength(10)
})

/** write.rs answers a verb's refusal as a bare string and api.rs its own 404s
 *  as `{error}`; a `said` assertion that passes here passes on the daemon. */
test('a verb refuses in text/plain, and only an api.rs 404 is JSON', async ({ request }) => {
  const missing = await request.post(`${api}/workspaces/nobody/up`, under('busy'))
  expect(missing.status()).toBe(404)
  expect(missing.headers()['content-type']).toBe('text/plain')
  expect(await missing.text()).toBe(
    'no workspace named `nobody` (looked for /home/biswa/.config/yantra/workspaces/nobody.toml)',
  )

  const exists = await request.post(`${api}/workspaces`, {
    ...under('busy'),
    data: { name: 'landing', machine: 'macbook', repo: '/x', startup: null },
  })
  expect(exists.status()).toBe(409)
  expect(exists.headers()['content-type']).toBe('text/plain')

  const status = await request.get(`${api}/workspaces/nobody/status`, under('busy'))
  expect(status.status()).toBe(404)
  expect(status.headers()['content-type']).toBe('application/json')
  expect(await status.json()).toEqual({ error: 'no workspace named `nobody`' })

  const nowhere = await request.get(`${api}/nowhere`, under('busy'))
  expect(nowhere.status()).toBe(404)
  expect(await nowhere.json()).toEqual({ error: 'this daemon serves no such route under /api' })
})

test('a delete with a session open is a 409 until force says otherwise', async ({ request }) => {
  const refused = await request.delete(`${api}/workspaces/landing`, under('busy'))
  expect(refused.status()).toBe(409)
  expect(refused.headers()['content-type']).toBe('text/plain')
  expect(await refused.text()).toContain('`landing` still has a session open on `macbook`')
  const still = await (await request.get(`${api}/workspaces`, under('busy'))).json()
  expect(still.data.map((w: { name: string }) => w.name)).toContain('landing')

  const moved = await request.patch(`${api}/workspaces/landing`, { ...under('busy'), data: { machine: 'pi-5' } })
  expect(moved.status()).toBe(409)
  expect(await moved.text()).toContain('cannot be moved off `macbook`')

  const forced = await request.delete(`${api}/workspaces/landing?force=true`, under('busy'))
  expect(forced.status()).toBe(204)
  const gone = await (await request.get(`${api}/workspaces`, under('busy'))).json()
  expect(gone.data.map((w: { name: string }) => w.name)).not.toContain('landing')
})

test('a read can be held for the pending state', async ({ request }) => {
  const started = Date.now()
  await request.get(`${api}/machines?slow=300`, under('busy'))
  expect(Date.now() - started).toBeGreaterThanOrEqual(300)
})
