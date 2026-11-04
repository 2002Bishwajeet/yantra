export const meta = {
  name: 'build-rows',
  description: 'Build open tracker rows unattended: rank, build, verify, review, simplify, merge (CLAUDE.md §B7)',
  whenToUse: 'The owner wants open tracker rows built and merged without reviewing each one',
  phases: [
    { title: 'Triage', detail: 'rank the rows an agent can finish alone' },
    { title: 'Build', detail: 'plan, build, verify, fix' },
    { title: 'Review', detail: 'independent review, fix, re-check' },
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

// Owner, 2026-11-03: the gate tests only what the branch changed. CI runs every suite on the PR, and ship waits for it.
// e2e runs in the image the screenshot baselines are rendered in; on the host, fonts differ. A missing baseline fails, not written.
const GATE = `Test only what this branch changed. List the files with \`git diff --name-only origin/main...HEAD\`. CI runs the full suites on the PR.
- A changed file under crates/ or a Cargo file: run \`just fmt-check && just lint\`, then \`YANTRA_REQUIRE_PODMAN=1 NEXTEST_TEST_THREADS=4 cargo nextest run -p <crate>\` for each changed crate.
- A changed file under web/: run \`cd web && npm ci --prefer-offline && npm run lint && npx tsc --noEmit -p tsconfig.app.json && npx vitest run --changed origin/main\`. Then run \`just web-e2e --update-snapshots=none <specs>\` with only the e2e specs that changed or that cover the changed screens. If no spec covers them, skip e2e.
- Nothing else changed: run \`just fmt-check\`.`

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
          paths: { type: 'array', items: { type: 'string' }, description: 'the files the change will edit, e.g. web/src/m3/Card.tsx; a folder only for new files in it' },
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
    flaky: { type: 'array', items: { type: 'string' }, description: 'tests that failed in the gate, are in files that `git diff --name-only origin/main...HEAD` does not list, and passed when rerun alone' },
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
    minor: { type: 'array', items: { type: 'string' }, description: 'every other finding, one line each' },
    doneMet: { type: 'boolean', description: "the row's done condition is met and proved by a test" },
    head: { type: 'string', description: 'git rev-parse HEAD of the worktree you reviewed' },
  },
  required: ['blocking', 'minor', 'doneMet', 'head'],
}

const SHIP_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['merged', 'open', 'checks-failed', 'behind', 'needs-verify', 'failed'] },
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
For each eligible row give its kind (rust-transport for ssh, tmux or socket code; rust; web; docs) and the files it will edit: read the code to find them, because a folder such as web/src blocks every other row in it. Put every row you rejected in skipped with one line of reason.`
}

const rank = (rows) => [...rows].sort((a, b) => a.priority - b.priority || Number(a.id.slice(2)) - Number(b.id.slice(2)))
// Rows that edit the same file never run at once; ship rebases one row at a time, so other overlaps resolve there.
const clash = (a, b) => a.paths.some((p) => b.paths.some((q) => p.startsWith(q) || q.startsWith(p)))

// The owner's own services run in podman on this box: a blanket `podman rm -f` took the chat agent down three times on 2026-11-03.
const CLEANUP = `Afterwards remove only the test containers: those with label yantra-fixture (podman ps -aq --filter label=yantra-fixture) and those named yantra-e2e-*. Never stop or remove any other container.`

// Every agent pays a ~50k-token start-up cost (2026-11-02 run), so the stages below share agents where the model rule allows.
// Y-493 parked because the agent read the log tail while the gate still ran, so the run must end in a sentinel line.
const GATE_HOW = `The gate can take longer than a 10-minute Bash call. Put the gate commands and the Then commands in one background shell: \`( <commands> ) > "$LOG" 2>&1; echo "GATE_EXIT=$?" >> "$LOG"\`. Wait with Monitor and an until-loop on \`grep -q '^GATE_EXIT=' "$LOG"\`, because a foreground sleep is blocked. Report nothing until that line exists. Judge pass from GATE_EXIT and the failing tests, never from a partial tail. ${CLEANUP}`

// A slow-network test outside the diff parked Y-585; CI runs the full suites again, so a real regression still blocks the merge.
const FLAKY = `When the gate fails, rerun each failing test alone. For nextest that is \`NEXTEST_TEST_THREADS=1 cargo nextest run -p <crate> -E 'test(=<name>)'\`, with YANTRA_REQUIRE_PODMAN=1 if the gate used it. For e2e that is one spec. A failure is a retry, not a failure, when its test file is outside \`git diff --name-only origin/main...HEAD\` and it passes alone. If every failure is like that, report pass=true and list those tests in flaky. Any other failure keeps pass=false.`

// A web or docs row is built by Sonnet, so one Sonnet agent can run the gate and fix what it finds.
async function verifyAndFix(row, wt, plan, label, attempts) {
  return serialVerify(() =>
    agent(
      `Run the gate for ${row.id} in ${wt}, fix what fails, and report whether it passes at the end.
Gate: ${GATE}
Then: ${plan.extraChecks.join(' && ') || 'nothing more'}
${GATE_HOW}
If a command fails, find the cause, fix the code, commit, and rerun only the failing test file or spec until it passes. Then rerun the gate once. Stop after ${attempts} gate runs.
${FLAKY} Do not change code for a flaky test.
A screenshot that the row's change was meant to alter: regenerate it with \`just web-e2e --update-snapshots=changed <spec>\` and commit the images. A screenshot it was not meant to alter is a regression: fix the code.
If a Then command fails before any test runs because the command is wrong, not the code, correct it and return the corrected list as fixedChecks.${RULES(wt)}`,
      { label: `gate:${row.id}:${label}`, phase: 'Build', schema: VERIFY_SCHEMA, model: 'sonnet', effort: 'medium' },
    ),
  )
}

async function verify(row, wt, plan, label) {
  return serialVerify(() =>
    agent(
      `Run the gate for ${row.id} in ${wt} and report whether it passes. Do not change any file.
Gate: ${GATE}
Then: ${plan.extraChecks.join(' && ') || 'nothing more'}
If a Then command fails before any test runs because the command is wrong, not the code, correct it, run the corrected one, judge pass on that, and return the corrected list as fixedChecks.
${GATE_HOW}
${FLAKY}`,
      { label: `verify:${row.id}:${label}`, phase: 'Build', schema: VERIFY_SCHEMA, model: 'sonnet', effort: 'low' },
    ),
  )
}

async function fix(row, wt, what) {
  const b = BUILDER[row.kind]
  // The fixer holds the verify lock, so it may rerun the failing tests itself and the next gate run is the last.
  return serialVerify(() => agent(
    `Fix ${row.id} in ${wt}. ${what}
Find the cause before you change code. Commit the fix. You hold the test lock: rerun only the failing tests (one podman test with NEXTEST_TEST_THREADS=4, or one e2e spec) until they pass. Do not run the gate. ${CLEANUP}${RULES(wt)}`,
    { label: `fix:${row.id}`, phase: 'Build', model: b.model, effort: b.effort },
  ))
}

async function verifyUntilGreen(row, wt, plan, rounds) {
  const selfFix = row.kind === 'web' || row.kind === 'docs'
  if (selfFix) {
    const v = await verifyAndFix(row, wt, plan, 'g', rounds)
    if (v?.fixedChecks?.length) plan.extraChecks = v.fixedChecks
    if (v?.flaky?.length) log(`${row.id}: retried outside its diff, passed alone: ${v.flaky.join(', ')}`)
    return !!(v && v.pass)
  }
  for (let i = 1; i <= rounds; i++) {
    const v = await verify(row, wt, plan, String(i))
    // A wrong check is the plan's bug, and no code fix can make it pass.
    if (v?.fixedChecks?.length) plan.extraChecks = v.fixedChecks
    if (v?.flaky?.length) log(`${row.id}: retried outside its diff, passed alone: ${v.flaky.join(', ')}`)
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

  // A retried row was parked on review findings, and only the report remembers them.
  const retried = RETRY.includes(row.id) ? `\nThe owner asked to retry this parked row. Read why it was parked in the reports in ${REPO}/.claude/build-loop/, and fix those findings first.` : ''

  const plan = await agent(
    `First set up the worktree. In ${REPO}: git fetch origin. Keep any work already on branch ${branch}, and never reset or delete its commits: they are work a parked run kept.
- If ${wt} exists, use it as it is.
- Else if branch ${branch} exists, run git worktree add ${wt} ${branch}.
- Else run git worktree add -b ${branch} ${wt} origin/main.
If ${branch} has commits ahead of origin/main, read them (git log -p origin/main..HEAD) and plan from where they stop.
Then plan ${row.id} ("${row.title}") in ${wt}. Read the row in tracker.md, the CLAUDE.md, tracker.md and llms.txt of each crate it touches, and the code.${retried}
Write a short plan and the checks that prove the row's done condition. Set park=true if the row needs something CLAUDE.md §B7 excludes.${RULES(wt)}`,
    { label: `plan:${row.id}`, phase: 'Build', schema: PLAN_SCHEMA, model: 'opus', effort: row.kind === 'rust-transport' ? 'high' : 'medium' },
  )
  if (!plan) return park('the planner died')
  if (plan.park) return park(plan.parkReason || 'the planner parked it')

  const b = BUILDER[row.kind]
  await agent(
    `Build ${row.id} ("${row.title}") in ${wt} to this plan:\n${plan.plan}\n
Write the tests that prove the done condition first, then the code. Run the fast checks yourself. Before you commit, load the simplify skill and apply it to git diff origin/main...HEAD, so the reviewer reads the final code. Commit.${RULES(wt)}`,
    { label: `build:${row.id}`, phase: 'Build', model: b.model, effort: b.effort },
  )
  if (!(await verifyUntilGreen(row, wt, plan, 3))) return park('the gate stayed red after 3 rounds')

  const REVIEW_RULE = `Put every finding in blocking or minor; none may be dropped. A finding is blocking when it makes the feature fail on a platform the row or the crate targets, stalls or drops the user's work, leaves state wrong after a failure, leaks a secret or private text, or breaks a crate invariant or a CLAUDE.md rule. Anything you would call "should hold the merge" is blocking. Only style, cost, cleanup and unlikely edge cases are minor. Do not change any file.`
  let r = await agent(
    `Review the change for ${row.id} in ${wt} (git diff origin/main...HEAD). You did not write it.
Load the code-review skill and review at high effort, with the target \`${wt}\` named explicitly: a review run without it reads the main checkout. Check it against the row's done condition in tracker.md and against the invariants of each crate it touches.
${REVIEW_RULE}`,
    { label: `review:${row.id}:1`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'opus', effort: 'high' },
  )
  // The 2026-11-02 run parked four rows after one fix, so a row gets two fixes, and a re-check reads only the findings and the fix.
  for (let fixes = 1; r && !(r.blocking.length === 0 && r.doneMet); fixes++) {
    if (fixes > 2) return park(`review still blocking: ${r.blocking.map((x) => x.issue).join('; ') || 'done condition not met'}`)
    const issues = r.blocking.map((x) => `- ${x.file}${x.line ? ':' + x.line : ''} ${x.issue}`).join('\n') + (r.doneMet ? '' : "\n- The row's done condition is not met or not proved by a test.")
    const base = r.head || 'HEAD~1'
    await fix(row, wt, `A reviewer found:\n${issues}\nFix every point. A fix that changes the approach must also update the tests and the docs it touches.`)
    if (!(await verifyUntilGreen(row, wt, plan, 2))) return park('the gate went red after review fixes')
    r = await agent(
      `Re-check the change for ${row.id} in ${wt}. You did not write it. An earlier review blocked it on:\n${issues}\n
Read the fix (git diff ${base}..HEAD) and the code each point names. For each point, decide if the fix resolves it. Also report any new defect the fix brings in. Do not review the rest of the change again.
${REVIEW_RULE}`,
      { label: `review:${row.id}:${fixes + 1}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'opus', effort: 'medium' },
    )
  }
  if (!r) return park('the reviewer died')

  const title = `${row.id}: ${row.title.charAt(0).toLowerCase()}${row.title.slice(1)}`
  // verified: the gate has passed on the code as it stands after the rebase, so a second rebase cannot ask for another.
  const ship = (verified) =>
    serialShip(() =>
      agent(
        `Ship ${row.id} from ${wt}, branch ${branch}. The gate passed.
0. git fetch origin and rebase on origin/main. Resolve conflicts in tracker.md and docs/session-log.md by keeping both sides and deduplicating by Y-number. Do not change any other file except to resolve a conflict. If a conflict in any other file cannot be resolved, abort the rebase and return failed.${verified ? '' : ` If origin/main changed a file this branch also touches, outside tracker.md and docs/session-log.md, or a conflict there needed a resolution, stop here and return needs-verify.`}
1. In tracker.md set the ${row.id} row to 🔵 review and add "**Merged ${TODAY}** by the build loop." with one line on what shipped. A row does not close in its own PR: a later release PR marks it ✅ done. Update the row; never add a second one. Then check: grep -oE '^\\| Y-[0-9]+ \\|' tracker.md | sort | uniq -d prints nothing. Skip this step if the row already says it.
2. Append one entry to docs/session-log.md for ${TODAY}, in the style of the entries above it. Plain prose, CLAUDE.md §A6. Skip this step if the entry exists.
3. Commit "${row.id}: record the change in the tracker" if steps 1–2 changed anything.${DRY ? `
4. Dry run: do not push. Return status open.` : `
4. Push with git push --force-with-lease -u origin ${branch}. If gh pr view ${branch} finds a PR, reuse it. Else run gh pr create --base main --title "${title}" with a body that says what changed and how it was verified. If the row names GitHub issues as #NNN, end the body with one "Closes #NNN" line for each, so the merge closes them. The title becomes the squash commit on main, so it must keep the form "Y-NNN: <what changed>". No AI attribution anywhere.
5. Run exactly one command: bash ${REPO}/.claude/workflows/merge-guard.sh <pr number> && gh pr merge <pr number> --squash --delete-branch --subject "${title} (#<pr number>)". The guard waits for every check and exits non-zero unless all are green. Never merge outside this command, and never call a red check unrelated. If the guard fails, return checks-failed with the failing check's log tail.
6. If GitHub says the branch is behind, return status behind; do not rebase here, because the rebase must be verified.
7. After a merge, run git worktree remove ${wt} from ${REPO} and delete the local branch.`}`,
        { label: `ship:${row.id}`, phase: 'Ship', schema: SHIP_SCHEMA, model: 'sonnet', effort: 'medium' },
      ),
    )

  let s = await ship(false)
  if (s && s.status === 'needs-verify') {
    if (!(await verifyUntilGreen(row, wt, plan, 2))) return park('the gate went red after the rebase')
    s = await ship(true)
  }
  if (s && s.status === 'checks-failed') {
    await fix(row, wt, `CI failed on the PR ${s.pr || ''}:\n${s.failures || ''}`)
    if (!(await verifyUntilGreen(row, wt, plan, 2))) return { ...park('CI failed and the fix did not pass the gate'), pr: s.pr }
    s = await ship(false)
  }
  if (s && s.status === 'behind') s = await ship(false)
  if (s && s.status === 'needs-verify') return park('origin/main moved under the branch twice; rerun to verify the rebase')
  if (!s) return park('the shipper died')
  return { id: row.id, title: row.title, status: s.status, pr: s.pr || '', reason: s.failures || '', branch }
}

const attempted = new Set()
const results = []
const skipped = new Map()
const only = A.rows || null

// One triage serves the run: the 2026-11-02 run re-triaged before every batch and got the same ranking four times.
phase('Triage')
const t = await agent(triagePrompt([]), { label: 'triage', phase: 'Triage', schema: TRIAGE_SCHEMA, model: 'opus', effort: 'medium' })
if (t) for (const s of t.skipped) skipped.set(s.id, s.reason)
// A pool, not batches: a row starts as soon as a slot frees, so one slow row no longer holds the next two.
const pool = t ? rank(t.rows.filter((r) => !only || only.includes(r.id))) : []
const running = new Map()
for (;;) {
  while (running.size < PARALLEL && results.length + running.size < MAX_ROWS) {
    const r = pool.find((x) => !attempted.has(x.id) && ![...running.values()].some((y) => clash(x, y.row)))
    if (!r) break
    attempted.add(r.id)
    log(`Start: ${r.id} (p${r.priority}, ${r.kind})`)
    const done = runRow(r)
      .catch(() => null)
      .then((o) => {
        results.push(o || { id: r.id, title: r.title, status: 'parked', reason: 'the row agent died' })
        running.delete(r.id)
      })
    running.set(r.id, { row: r, done })
  }
  if (!running.size) break
  await Promise.race([...running.values()].map((x) => x.done))
}
if (pool.some((r) => !attempted.has(r.id))) log(`Stopped at maxRows=${MAX_ROWS}; ${pool.filter((r) => !attempted.has(r.id)).map((r) => r.id).join(', ')} not started.`)

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
