export const meta = {
  name: 'build-rows',
  description: 'Build open tracker rows unattended: rank, build, verify, review, simplify, merge (CLAUDE.md §B7)',
  whenToUse: 'The owner wants open tracker rows built and merged without reviewing each one',
  phases: [
    { title: 'Triage', detail: 'rank the rows an agent can finish alone' },
    { title: 'Build', detail: 'plan, build, verify, fix' },
    { title: 'Review', detail: 'independent review, fix, simplify' },
    { title: 'Ship', detail: 'one row at a time: rebase, tracker, PR, checks, merge' },
    { title: 'Report' },
  ],
}

// args: { today: 'YYYY-MM-DD' (required), maxRows?: 3, parallel?: 3, rows?: ['Y-371'], retry?: ['Y-417'], dryRun?: false }
const A = args || {}
if (!A.today) throw new Error('pass args.today as YYYY-MM-DD')
const TODAY = A.today
const MAX_ROWS = A.maxRows ?? 3
const PARALLEL = A.parallel ?? 3
const DRY = !!A.dryRun
const RETRY = A.retry || []
const REPO = '/home/biswa/Github/homelab/yantra'
const WT_ROOT = `${REPO}/.claude/worktrees`
const REPORT = `${REPO}/.claude/build-loop/${TODAY}.md`

const BUILDER = {
  'rust-transport': { model: 'opus', effort: 'high' },
  rust: { model: 'opus', effort: 'medium' },
  web: { model: 'sonnet', effort: 'medium' },
  docs: { model: 'sonnet', effort: 'low' },
}

const RUST_GATE = 'YANTRA_REQUIRE_PODMAN=1 NEXTEST_TEST_THREADS=4 just check'
// e2e runs in the image the screenshot baselines are rendered in; on the host, fonts differ. A missing baseline fails, not written.
const WEB_GATE = '(cd web && npm ci --prefer-offline && npm run lint && npm test && npm run build && npm run budget) && just web-e2e --update-snapshots=none'
// A row's gate follows the paths it touches, not only its kind: a web row that changes the daemon runs both.
const gate = (row) => {
  const rust = row.kind.startsWith('rust') || row.paths.some((p) => p.startsWith('crates') || p.startsWith('Cargo'))
  const web = row.kind === 'web' || row.paths.some((p) => p.startsWith('web'))
  return [rust && RUST_GATE, web && WEB_GATE].filter(Boolean).join(' && ') || 'just fmt-check'
}

const RULES = (wt) => `
Rules for this run (CLAUDE.md §B7, the build loop):
- Work only inside the worktree ${wt}. Never touch ${REPO} itself.
- Do not edit tracker.md or docs/session-log.md. The ship stage does that.
- Do not create or change anything under docs/adr/, and do not add or change an invariant in a crate tracker. If the row needs either, stop and say so.
- Commit messages are "Y-NNN: <what changed>" and carry no AI attribution of any kind.
- Never run the podman suite, \`just check\`, or Playwright in any form (\`just web-e2e\`, \`npm run e2e\`, \`npx playwright test\`). The verify stage runs them one row at a time, because parallel suites run the box out of memory. The one exception: when your gate includes \`just web-e2e\`, a fix agent may run \`just web-e2e --update-snapshots=changed <spec>\` to regenerate a baseline that its change was meant to alter, and commits the new images. Never regenerate a baseline on the host: its fonts differ. You may run \`just fmt-check\`, \`just lint\`, \`cargo nextest run -p <crate>\` without YANTRA_REQUIRE_PODMAN, and the web lint and unit tests.
- Web code: load the skills vercel-react-best-practices, tanstack-router-best-practices, tanstack-query-best-practices, playwright-best-practices and accessibility before you write any. Errors are typed and every error path is tested.`

function lock() {
  let tail = Promise.resolve()
  return (fn) => {
    const run = tail.then(fn)
    tail = run.catch(() => {})
    return run
  }
}
// Verification is serial so three podman or e2e suites never share 15 GB; shipping is serial so rebases see each other's merges.
const serialVerify = lock()
const serialShip = lock()

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', enum: Object.keys(BUILDER) },
          paths: { type: 'array', items: { type: 'string' }, description: 'top-level paths the change will touch, e.g. web/src/m3' },
          priority: { type: 'integer', minimum: 1, maximum: 4 },
          reason: { type: 'string' },
        },
        required: ['id', 'title', 'kind', 'paths', 'priority', 'reason'],
      },
    },
    skipped: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
    },
  },
  required: ['rows', 'skipped'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    park: { type: 'boolean' },
    parkReason: { type: 'string' },
    plan: { type: 'string' },
    extraChecks: { type: 'array', items: { type: 'string' }, description: 'commands beyond the standard gate that prove the done condition. Each must run as written: `yantrad` is binary-only, so use `--bin yantrad` and never `--lib`, and a nextest filter must match a test (check with `cargo nextest list`). Leave it empty when the gate already proves the row.' },
  },
  required: ['park', 'plan', 'extraChecks'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    failures: { type: 'string', description: 'the failing command and the last 60 lines of its output' },
    fixedChecks: { type: 'array', items: { type: 'string' }, description: 'only when a Then command is itself wrong (an unknown target, a filter that matches no test): every Then command, corrected' },
  },
  required: ['pass', 'failures'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'integer' }, issue: { type: 'string' } },
        required: ['file', 'issue'],
      },
    },
    doneMet: { type: 'boolean', description: "the row's done condition is met and proved by a test" },
    diffLines: { type: 'integer', description: 'added plus removed lines against origin/main' },
  },
  required: ['blocking', 'doneMet', 'diffLines'],
}

const SETUP_SCHEMA = {
  type: 'object',
  properties: { commitsAhead: { type: 'integer', minimum: 0 } },
  required: ['commitsAhead'],
}

const REBASE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'false when the rebase had conflicts it could not resolve' },
    codeChanged: { type: 'boolean', description: 'origin/main changed files this branch also touches, or the rebase needed a conflict resolution' },
    failures: { type: 'string' },
  },
  required: ['ok', 'codeChanged'],
}

const SHIP_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['merged', 'open', 'checks-failed', 'behind', 'failed'] },
    pr: { type: 'string' },
    failures: { type: 'string' },
  },
  required: ['status'],
}

function triagePrompt(exclude) {
  return `Run git -C ${REPO} fetch origin, then read tracker.md from origin/main with git -C ${REPO} show origin/main:tracker.md. Do not read the file in the checkout: it can be stale or on another branch.
Rank the open rows in its §3 that an agent can finish alone today.

Eligible: status ⬜ todo, every row in Depends is ✅ done or 🔵 review (a 🔵 review row has merged; only a release has not marked it), and an agent can prove the done condition on this Linux box with cargo, podman and Playwright.
Not eligible: anything CLAUDE.md §B7 excludes. That covers rows that need the owner, a phone, a real Mac, a Pi, audio hardware, Figma or Claude Design, a release cut, a new or amended ADR, or an answer to an open question.
Also skip: ${exclude.length ? exclude.join(', ') : 'nothing else'}.
Also skip a row that an earlier report in ${REPO}/.claude/build-loop/ parked, unless its reason no longer holds on origin/main.${RETRY.length ? `\nThe owner asked to retry these parked rows, so they are eligible if nothing else rules them out: ${RETRY.join(', ')}.` : ''}

Priority, from CLAUDE.md §B7: 1 = closes or unblocks an open milestone, 2 = a defect or a red suite, 3 = a feature whose dependencies are done, 4 = debt. Ties go to the lower Y-number.
For each eligible row give its kind (rust-transport for ssh, tmux or socket code; rust; web; docs) and the paths it will touch. Put every row you rejected in skipped with one line of reason.`
}

function pickBatch(rows, n) {
  const sorted = [...rows].sort((a, b) => a.priority - b.priority || Number(a.id.slice(2)) - Number(b.id.slice(2)))
  const overlaps = (p, q) => p.startsWith(q) || q.startsWith(p)
  const batch = []
  for (const r of sorted) {
    if (batch.length === n) break
    if (batch.some((b) => b.paths.some((p) => r.paths.some((q) => overlaps(p, q))))) continue
    batch.push(r)
  }
  return batch
}

async function verify(row, wt, plan, label) {
  return serialVerify(() =>
    agent(
      `Run the gate for ${row.id} in ${wt} and report whether it passes. Do not change any file.
Gate: ${gate(row)}
Then: ${plan.extraChecks.join(' && ') || 'nothing more'}
If a Then command fails before any test runs because the command is wrong, not the code, correct it, run the corrected one, judge pass on that, and return the corrected list as fixedChecks.
The gate can take longer than a 10-minute Bash call: run it in the background and wait for it to finish.
Remove leftover podman containers afterwards.`,
      { label: `verify:${row.id}:${label}`, phase: 'Build', schema: VERIFY_SCHEMA, model: 'sonnet', effort: 'low' },
    ),
  )
}

async function fix(row, wt, what) {
  const b = BUILDER[row.kind]
  // A web fix may regenerate baselines in a podman container, so it takes the verify lock.
  const run = gate(row).includes('web-e2e') ? serialVerify : (fn) => fn()
  return run(() => agent(
    `Fix ${row.id} in ${wt}. ${what}
Find the cause before you change code. Commit the fix.${RULES(wt)}`,
    { label: `fix:${row.id}`, phase: 'Build', model: b.model, effort: b.effort },
  ))
}

async function verifyUntilGreen(row, wt, plan, rounds) {
  for (let i = 1; i <= rounds; i++) {
    const v = await verify(row, wt, plan, String(i))
    // A wrong check is the plan's bug, and no code fix can make it pass.
    if (v?.fixedChecks?.length) plan.extraChecks = v.fixedChecks
    if (v && v.pass) return true
    if (i === rounds) return false
    if (v) await fix(row, wt, `The gate failed:\n${v.failures}`)
  }
  return false
}

async function runRow(row) {
  const branch = `${row.id.toLowerCase()}-auto`
  const wt = `${WT_ROOT}/${branch}`
  const park = (reason) => ({ id: row.id, title: row.title, status: 'parked', reason, branch })

  const setup = await agent(
    `In ${REPO}: run git fetch origin. Then make ${wt} a worktree on branch ${branch}, keeping any work already on that branch:
- If ${wt} exists, use it as it is.
- Else if branch ${branch} exists, run git worktree add ${wt} ${branch}.
- Else run git worktree add -b ${branch} ${wt} origin/main.
Never reset or delete existing commits: they are work a parked run kept. Report how many commits ${branch} has ahead of origin/main.`,
    { label: `setup:${row.id}`, phase: 'Build', schema: SETUP_SCHEMA, model: 'sonnet', effort: 'low' },
  )
  if (!setup) return park('the setup agent died')
  // A retried row was parked on review findings, and only the report remembers them.
  const retried = RETRY.includes(row.id) ? `\nThe owner asked to retry this parked row. Read why it was parked in the reports in ${REPO}/.claude/build-loop/, and fix those findings first.` : ''
  const prior = setup.commitsAhead > 0 ? `\nThe branch already has ${setup.commitsAhead} commits from an earlier run. Read them (git log -p origin/main..HEAD) and plan from where they stop.` : ''

  const plan = await agent(
    `Plan ${row.id} ("${row.title}") in ${wt}. Read the row in tracker.md, the CLAUDE.md, tracker.md and llms.txt of each crate it touches, and the code.${prior}${retried}
Write a short plan and the checks that prove the row's done condition. Set park=true if the row needs something CLAUDE.md §B7 excludes.${RULES(wt)}`,
    { label: `plan:${row.id}`, phase: 'Build', schema: PLAN_SCHEMA, model: 'opus', effort: row.kind === 'rust-transport' ? 'high' : 'medium' },
  )
  if (!plan) return park('the planner died')
  if (plan.park) return park(plan.parkReason || 'the planner parked it')

  const b = BUILDER[row.kind]
  await agent(
    `Build ${row.id} ("${row.title}") in ${wt} to this plan:\n${plan.plan}\n
Write the tests that prove the done condition first, then the code. Run the fast checks yourself and commit.${RULES(wt)}`,
    { label: `build:${row.id}`, phase: 'Build', model: b.model, effort: b.effort },
  )
  if (!(await verifyUntilGreen(row, wt, plan, 3))) return park('the gate stayed red after 3 rounds')

  // Simplify runs before the last review, so no code merges that a reviewer has not read.
  let simplified = false
  let fixes = 0
  for (let round = 1; ; round++) {
    const r = await agent(
      `Review the change for ${row.id} in ${wt} (git diff origin/main...HEAD). You did not write it.
Load the code-review skill and review at high effort, with the target \`${wt}\` named explicitly: a review run without it reads the main checkout. Check it against the row's done condition in tracker.md and against the invariants of each crate it touches.
List only defects that must be fixed before merge as blocking. Do not change any file.`,
      { label: `review:${row.id}:${round}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'opus', effort: 'high' },
    )
    if (!r) return park('the reviewer died')
    if (r.blocking.length === 0 && r.doneMet) {
      if (r.diffLines <= 250 || simplified) break
      simplified = true
      await agent(
        `In ${wt}, load the simplify skill and apply it to git diff origin/main...HEAD. Keep behaviour and tests unchanged. Commit.${RULES(wt)}`,
        { label: `simplify:${row.id}`, phase: 'Review', model: 'sonnet', effort: 'medium' },
      )
      if (!(await verifyUntilGreen(row, wt, plan, 2))) return park('the gate went red after simplify')
      continue
    }
    if (++fixes > 1) return park(`review still blocking: ${r.blocking.map((x) => x.issue).join('; ') || 'done condition not met'}`)
    const issues = r.blocking.map((x) => `- ${x.file}${x.line ? ':' + x.line : ''} ${x.issue}`).join('\n')
    await fix(row, wt, `A reviewer found:\n${issues}${r.doneMet ? '' : "\n- The row's done condition is not met or not proved by a test."}`)
    if (!(await verifyUntilGreen(row, wt, plan, 2))) return park('the gate went red after review fixes')
  }

  const title = `${row.id}: ${row.title.charAt(0).toLowerCase()}${row.title.slice(1)}`
  const ship = () =>
    serialShip(async () => {
      const rb = await agent(
        `In ${wt} on branch ${branch}: git fetch origin and rebase on origin/main. Resolve conflicts in tracker.md and docs/session-log.md by keeping both sides and deduplicating by Y-number. Do not change any other file except to resolve a conflict.`,
        { label: `rebase:${row.id}`, phase: 'Ship', schema: REBASE_SCHEMA, model: 'sonnet', effort: 'medium' },
      )
      if (!rb || !rb.ok) return { status: 'failed', failures: rb ? rb.failures || 'rebase conflicts' : 'the rebase agent died' }
      if (rb.codeChanged) {
        const v = await verify(row, wt, plan, 'rebase')
        if (!v || !v.pass) return { status: 'failed', failures: v ? v.failures : 'the verifier died after the rebase' }
      }
      return agent(
        `Ship ${row.id} from ${wt}, branch ${branch}. The branch is rebased on origin/main and the gate passed.
1. In tracker.md set the ${row.id} row to 🔵 review and add "**Merged ${TODAY}** by the build loop." with one line on what shipped. A row does not close in its own PR: a later release PR marks it ✅ done. Update the row; never add a second one. Then check: grep -oE '^\\| Y-[0-9]+ \\|' tracker.md | sort | uniq -d prints nothing. Skip this step if the row already says it.
2. Append one entry to docs/session-log.md for ${TODAY}, in the style of the entries above it. Plain prose, CLAUDE.md §A6. Skip this step if the entry exists.
3. Commit "${row.id}: record the change in the tracker" if steps 1–2 changed anything.${DRY ? `
4. Dry run: do not push. Return status open.` : `
4. Push with git push --force-with-lease -u origin ${branch}. If gh pr view ${branch} finds a PR, reuse it. Else run gh pr create --base main --title "${title}" with a body that says what changed and how it was verified. The title becomes the squash commit on main, so it must keep the form "Y-NNN: <what changed>". No AI attribution anywhere.
5. Wait for the checks (gh pr checks --watch). The merge guard: the five required checks clippy, deny, fmt, test and "cross (aarch64-unknown-linux-musl)" are present by name, and every check in gh pr view --json statusCheckRollup is SUCCESS, SKIPPED or NEUTRAL. If any is not, return checks-failed with the failing check's log tail.
6. Merge with gh pr merge --squash --delete-branch --subject "${title} (#<pr number>)". If GitHub says the branch is behind, return status behind; do not rebase here, because the rebase must be verified.
7. After a merge, run git worktree remove ${wt} from ${REPO} and delete the local branch.`}`,
        { label: `ship:${row.id}`, phase: 'Ship', schema: SHIP_SCHEMA, model: 'sonnet', effort: 'medium' },
      )
    })

  let s = await ship()
  if (s && s.status === 'checks-failed') {
    await fix(row, wt, `CI failed on the PR ${s.pr || ''}:\n${s.failures || ''}`)
    if (!(await verifyUntilGreen(row, wt, plan, 2))) return { ...park('CI failed and the fix did not pass the gate'), pr: s.pr }
    s = await ship()
  }
  if (s && s.status === 'behind') s = await ship()
  if (!s) return park('the shipper died')
  return { id: row.id, title: row.title, status: s.status, pr: s.pr || '', reason: s.failures || '', branch }
}

const attempted = new Set()
const results = []
const skipped = new Map()
const only = A.rows || null

while (results.length < MAX_ROWS) {
  phase('Triage')
  const t = await agent(triagePrompt([...attempted]), { label: 'triage', phase: 'Triage', schema: TRIAGE_SCHEMA, model: 'opus', effort: 'medium' })
  if (!t) break
  for (const s of t.skipped) skipped.set(s.id, s.reason)
  const pool = t.rows.filter((r) => !attempted.has(r.id) && (!only || only.includes(r.id)))
  const batch = pickBatch(pool, Math.min(PARALLEL, MAX_ROWS - results.length))
  if (!batch.length) break
  log(`Batch: ${batch.map((r) => `${r.id} (p${r.priority}, ${r.kind})`).join(', ')}`)
  batch.forEach((r) => attempted.add(r.id))
  const out = await parallel(batch.map((r) => () => runRow(r)))
  out.forEach((o, i) => results.push(o || { id: batch[i].id, title: batch[i].title, status: 'parked', reason: 'the row agent died' }))
}
if (results.length >= MAX_ROWS) log(`Stopped at maxRows=${MAX_ROWS}; more rows may be eligible.`)

phase('Report')
await agent(
  `Write ${REPORT} (create the folder if needed). If it exists, an earlier run today wrote it: keep its text and append this run under a \`## Another run\` heading. It is the owner's morning report for the build loop on ${TODAY}. Plain prose, CLAUDE.md §A6.
Open with one line: how many rows merged, stayed open and parked.
Then a table: row, title, outcome, PR, and for parked rows the reason and the branch that holds the work.
Then the rows triage skipped, one line each.
Results: ${JSON.stringify(results)}
Skipped: ${JSON.stringify([...skipped].map(([id, reason]) => ({ id, reason })))}`,
  { label: 'report', phase: 'Report', model: 'sonnet', effort: 'low' },
)

return { report: REPORT, results, skipped: [...skipped].map(([id, reason]) => ({ id, reason })) }
