// Enough of yantrad for the browser to run against: every `/api` route the
// dashboard calls, answered from contract.gen.ts's fixtures under a scenario
// overlay, and both terminal sockets. Nothing here is the daemon's logic —
// writes mutate an in-memory copy so the next read agrees with them.
//
//   node e2e/fixture/server.mjs            FIXTURE_PORT=7790 FIXTURE_SCENARIO=busy
//
// A request picks its scenario with the `x-fixture-scenario` header or the
// `fixture-scenario` cookie, `name` or `name#key` — the key gives one test its
// own copy of the state, so a create in one worker is not a row in another.
// `?slow=ms` on a read, or a `fixture-slow` cookie, holds the answer for the
// pending state.
//
// Three scenario fields are about the wire rather than the fleet. `refuse`
// answers every write and every terminal upgrade with that status and text,
// as the daemon's write authoriser does (write.rs, `Refused`). `flaky` fails
// each read once with a 502 and then answers it, and refuses each terminal
// target once with a text frame before accepting it. `broken` is an overlay
// of bodies that do not match the contract, keyed by path.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import * as contract from '../../src/contract.gen.ts'

const PORT = Number(process.env.FIXTURE_PORT ?? 7790)
const DEFAULT = process.env.FIXTURE_SCENARIO ?? 'busy'
const TERM = 'xterm-256color'

// What Claude prints when it wants a decision — the box SessionTerminal.dc.html
// draws, sent as terminal bytes the moment a socket is sized.
const TRUST_PROMPT = [
  '● Bash(cargo test -p yantra-core)',
  '  ⎿  Waiting…',
  '',
  '╭──────────────────────────────────────────────────────────────────────────────╮',
  '│ Bash command                                                                 │',
  '│                                                                              │',
  '│   cargo test -p yantra-core                                                  │',
  '│   Run the core crate\'s tests, including the container fixture                │',
  '│                                                                              │',
  '│ Do you want to proceed?                                                      │',
  '│ > 1. Yes                                                                     │',
  '│   2. Yes, and don\'t ask again for cargo test commands in ~/Github/yantra     │',
  '│   3. No, and tell Claude what to do differently (esc)                        │',
  '╰──────────────────────────────────────────────────────────────────────────────╯',
  '',
  '> ',
].join('\r\n')

const scenarios = new URL('./scenarios/', import.meta.url)

/** The raw fixtures, which is also what the `contract` scenario serves. */
function defaults() {
  return {
    machines: contract.machines,
    workspaces: contract.workspaces,
    sessions: contract.sessions,
    readiness: contract.readiness,
    attention: contract.attention,
    github: { looked: 'never' },
    notifications: contract.notifications,
    about: contract.about,
    status: Object.fromEntries(
      contract.agents.map((one) => [one.data.workspace, one]),
    ),
  }
}

function load(name) {
  if (name === 'contract') return defaults()
  const file = JSON.parse(readFileSync(new URL(`${name}.json`, scenarios), 'utf8'))
  const { extends: base, ...overlay } = file
  return { ...(base ? load(base) : defaults()), ...overlay }
}

const states = new Map()

/** One mutable copy per `scenario#key`, made on first use. */
function stateFor(selector) {
  if (!states.has(selector)) {
    const [name] = selector.split('#')
    states.set(selector, structuredClone(load(name)))
  }
  return states.get(selector)
}

function cookies(request) {
  const out = {}
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key) out[key] = decodeURIComponent(rest.join('='))
  }
  return out
}

function select(request) {
  const jar = cookies(request)
  const url = new URL(request.url, 'http://fixture')
  return {
    state: stateFor(
      request.headers['x-fixture-scenario'] ?? jar['fixture-scenario'] ?? DEFAULT,
    ),
    slow: Number(url.searchParams.get('slow') ?? jar['fixture-slow'] ?? 0),
    url,
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString()
  return text ? JSON.parse(text) : {}
}

const ok = (data, age = 0) => ({ looked: 'ok', age_seconds: age, data })

const failedLike = (envelope) => (envelope.looked === 'failed' ? envelope : null)

function findWorkspace(state, name) {
  const list = state.workspaces
  if (list.looked !== 'ok') return null
  return list.data.find((one) => one.name === name) ?? null
}

function sessionsOf(state, machine) {
  if (state.sessions.looked !== 'ok') return null
  return state.sessions.data.find((one) => one.machine === machine) ?? null
}

function setStatus(state, workspace, status, session) {
  state.status[workspace.name] = ok({
    workspace: workspace.name,
    machine: workspace.machine,
    reached: 'yes',
    status,
    session,
  })
}

/** Route table: method, path pattern, handler. A handler answers
 *  `[status, json]`, `[status]` for an empty body, or `null` to fall through. */
const routes = [
  ['GET', /^\/api\/machines$/, (s) => [200, s.machines]],
  ['GET', /^\/api\/workspaces$/, (s) => [200, s.workspaces]],
  ['GET', /^\/api\/sessions$/, (s) => [200, s.sessions]],
  ['GET', /^\/api\/readiness$/, (s) => [200, s.readiness]],
  ['GET', /^\/api\/attention$/, (s) => [200, s.attention]],
  ['GET', /^\/api\/readiness\/github$/, (s) => [200, s.github]],
  ['GET', /^\/api\/notifications$/, (s) => [200, s.notifications]],
  ['GET', /^\/api\/about$/, (s) => [200, s.about]],
  [
    'GET',
    /^\/api\/workspaces\/([^/]+)\/status$/,
    (s, [name]) => {
      const one = s.status[name] ?? failedLike(s.workspaces)
      return one ? [200, one] : [404, { error: `no workspace named ${name}` }]
    },
  ],
  [
    /GET|POST/,
    /^\/api\/machines\/([^/]+)\/readiness$/,
    (s, [machine]) => {
      if (s.readiness.looked !== 'ok') return [200, s.readiness]
      const one = s.readiness.data.find((r) => r.machine === machine)
      return one ? [200, ok(one)] : [404, { error: `no machine named ${machine}` }]
    },
  ],
  [
    'POST',
    /^\/api\/workspaces$/,
    (s, _, sent) => {
      if (!sent.name || !sent.machine || !sent.repo) {
        return [400, { error: 'a workspace needs a name, a machine and a repo' }]
      }
      if (findWorkspace(s, sent.name)) {
        return [409, { error: `workspace \`${sent.name}\` already exists` }]
      }
      const made = {
        name: sent.name,
        machine: sent.machine,
        repo: sent.repo,
        startup: sent.startup ?? null,
      }
      s.workspaces.data.push({ loaded: 'yes', ...made })
      setStatus(s, made, { state: 'no_session' }, null)
      return [201, made]
    },
  ],
  [
    'PATCH',
    /^\/api\/workspaces\/([^/]+)$/,
    (s, [name], sent) => {
      const one = findWorkspace(s, name)
      if (!one) return [404, { error: `no workspace named ${name}` }]
      Object.assign(one, sent)
      const { loaded: _, ...workspace } = one
      return [200, workspace]
    },
  ],
  [
    'DELETE',
    /^\/api\/workspaces\/([^/]+)$/,
    (s, [name]) => {
      if (!findWorkspace(s, name)) return [404, { error: `no workspace named ${name}` }]
      s.workspaces.data = s.workspaces.data.filter((one) => one.name !== name)
      delete s.status[name]
      return [204]
    },
  ],
  [
    'POST',
    /^\/api\/workspaces\/([^/]+)\/up$/,
    (s, [name]) => {
      const one = findWorkspace(s, name)
      if (!one) return [404, { error: `no workspace named ${name}` }]
      const was = s.status[name]?.data
      const live = was?.reached === 'yes' && was.session !== null
      setStatus(s, one, { state: 'running' }, live ? was.session : { id: crypto.randomUUID(), pid: 40000 + Math.floor(Math.random() * 9999) })
      const host = sessionsOf(s, one.machine)
      if (host?.reached === 'yes' && !host.sessions.some((t) => t.name === name)) {
        host.sessions.push({ name, windows: 1, attached: 0, created: 'Sun Sep  6 12:00:00 2026' })
      }
      return [200, { machine: one.machine, session: live ? 'attached' : 'created', launched: !live, term: TERM }]
    },
  ],
  [
    'POST',
    /^\/api\/workspaces\/([^/]+)\/down$/,
    (s, [name]) => {
      const one = findWorkspace(s, name)
      if (!one) return [404, { error: `no workspace named ${name}` }]
      const was = s.status[name]?.data
      const live = was?.reached === 'yes' && was.status.state !== 'no_session'
      setStatus(s, one, { state: 'stopped' }, null)
      return [200, { machine: one.machine, stopped: live, ending: live ? 'Finished' : null }]
    },
  ],
  [
    'POST',
    /^\/api\/workspaces\/([^/]+)\/resume$/,
    (s, [name]) => {
      const one = findWorkspace(s, name)
      if (!one) return [404, { error: `no workspace named ${name}` }]
      const was = s.status[name]?.data
      const running = was?.reached === 'yes' && was.status.state === 'running'
      if (!running) setStatus(s, one, { state: 'running' }, { id: crypto.randomUUID(), pid: 40000 })
      return [200, { machine: one.machine, resumed: !running, term: TERM }]
    },
  ],
  ['POST', /^\/api\/workspaces\/([^/]+)\/tokens$/, () => [200, contract.spend]],
  ['POST', /^\/api\/workspaces\/([^/]+)\/logs$/, () => [200, contract.logs]],
  [
    'GET',
    /^\/api\/workspaces\/([^/]+)\/repair$/,
    (s, [name]) => {
      const one = s.workspaces.looked === 'ok' && s.workspaces.data.find((w) => w.name === name)
      if (!one) return [404, { error: `no workspace named ${name}` }]
      if (one.loaded === 'yes') return [409, { error: `workspace \`${name}\` loads, so there is nothing to repair` }]
      return [200, { ...contract.broken, name, error: one.error }]
    },
  ],
  [
    'POST',
    /^\/api\/workspaces\/([^/]+)\/repair$/,
    (s, [name], sent) => {
      const index = s.workspaces.looked === 'ok' ? s.workspaces.data.findIndex((w) => w.name === name) : -1
      if (index < 0) return [404, { error: `no workspace named ${name}` }]
      if (typeof sent.text !== 'string' || !sent.text.includes('machine')) {
        return [422, { error: 'that text still does not load: missing field `machine`' }]
      }
      const mended = { loaded: 'yes', ...contract.made, name }
      s.workspaces.data[index] = mended
      setStatus(s, mended, { state: 'no_session' }, null)
      return [200, { ...contract.made, name }]
    },
  ],
  [
    'DELETE',
    /^\/api\/machines\/([^/]+)\/sessions\/([^/]+)$/,
    (s, [machine, session]) => {
      const host = sessionsOf(s, machine)
      const had = host?.reached === 'yes' && host.sessions.some((t) => t.name === session)
      if (had) host.sessions = host.sessions.filter((t) => t.name !== session)
      return [200, { machine, session, killed: had }]
    },
  ],
  [
    'POST',
    /^\/api\/machines\/([^/]+)\/probe$/,
    (_, [machine], sent) => [200, { machine, path: sent.path ?? '', exists: true, origin: null }],
  ],
  [
    'POST',
    /^\/api\/machines\/([^/]+)\/dirs$/,
    (_, [machine], sent) => [200, { ...contract.listing, machine, path: sent.path ?? contract.listing.path }],
  ],
  ['POST', /^\/api\/relay$/, (_, __, sent) => (sent.url ? [204] : [400, { error: 'a relay needs a topic URL' }])],
  ['POST', /^\/api\/viewing$/, () => [204]],
  ['POST', /^\/api\/heartbeat$/, () => [204]],
]

/** Under `flaky`, the first time a target is asked for it fails; the record
 *  of who has already paid is per state copy. */
function flakes(state, target) {
  if (!state.flaky) return false
  state.paid ??= []
  if (state.paid.includes(target)) return false
  state.paid.push(target)
  return true
}

const server = createServer(async (request, response) => {
  const { state, slow, url } = select(request)
  if (url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }
  if (request.method === 'GET' && flakes(state, url.pathname)) {
    response.writeHead(502, { 'content-type': 'text/plain' }).end('bad gateway')
    return
  }
  if (state.refuse && request.method !== 'GET') {
    response.writeHead(state.refuse.status, { 'content-type': 'text/plain' }).end(state.refuse.text)
    return
  }
  for (const [method, pattern, handle] of routes) {
    const hit = method instanceof RegExp ? method.test(request.method) : method === request.method
    const match = hit && url.pathname.match(pattern)
    if (!match) continue
    const params = match.slice(1).map(decodeURIComponent)
    const sent = request.method === 'GET' ? {} : await body(request)
    if (slow > 0 && request.method === 'GET') await sleep(slow)
    const [status, json] = state.broken?.[url.pathname]
      ? [200, state.broken[url.pathname]]
      : handle(state, params, sent)
    if (json === undefined) {
      response.writeHead(status).end()
    } else {
      response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify(json))
    }
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' }).end(
    JSON.stringify({ error: `the fixture has no ${request.method} ${url.pathname}` }),
  )
})

// Both sockets from terminal.rs: binary both ways, the browser's first text
// frame is `{rows, cols, term}`, and a text frame from here is a refusal.
const sockets = new WebSocketServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  const { state, url } = select(request)
  const workspace = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/terminal$/)
  const session = url.pathname.match(/^\/api\/machines\/([^/]+)\/sessions\/([^/]+)\/terminal$/)
  if (!workspace && !session) {
    socket.destroy()
    return
  }
  if (state.refuse) {
    socket.end(
      `HTTP/1.1 ${state.refuse.status} Refused\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${state.refuse.text}`,
    )
    return
  }
  const refusal = workspace
    ? findWorkspace(state, decodeURIComponent(workspace[1]))
      ? null
      : `no workspace named ${decodeURIComponent(workspace[1])}`
    : sessionsOf(state, decodeURIComponent(session[1]))?.sessions?.some(
          (t) => t.name === decodeURIComponent(session[2]),
        )
      ? null
      : `tmux: can't find session: =${decodeURIComponent(session[2])}`
  const flaked = flakes(state, url.pathname)
    ? 'ssh: connect to host port 22: Connection reset by peer'
    : null

  sockets.handleUpgrade(request, socket, head, (ws) => {
    let sized = false
    ws.on('message', (data, binary) => {
      if (!sized) {
        if (binary) {
          ws.send('the first frame must say the window size', { binary: false })
          ws.close()
          return
        }
        let size
        try {
          size = JSON.parse(data.toString())
        } catch {
          size = null
        }
        if (!size || typeof size.rows !== 'number' || typeof size.cols !== 'number' || typeof size.term !== 'string') {
          ws.send('the first frame must be {rows, cols, term}', { binary: false })
          ws.close()
          return
        }
        sized = true
        if (refusal || flaked) {
          ws.send(refusal ?? flaked, { binary: false })
          ws.close()
          return
        }
        ws.send(Buffer.from(TRUST_PROMPT), { binary: true })
        return
      }
      if (binary) ws.send(data, { binary: true })
    })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fixture listening on http://127.0.0.1:${PORT} scenario=${DEFAULT}`)
})
