export const meta = {
  name: 'build-rows',
  description: 'Build open tracker rows unattended: rank, build, verify, review, simplify, merge (CLAUDE.md §B7)',
  whenToUse: 'The owner wants open tracker rows built and merged without reviewing each one',
  phases: [
    { title: 'Triage', detail: 'rank the rows an agent can finish alone' },
    { title: 'Build', detail: 'plan, build, CI gate, fix' },
    { title: 'Review', detail: 'independent review, fix, re-check' },
    { title: 'Ship', detail: 'one row at a time: rebase, tracker, checks, merge' },
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
const GATE_LOGS = `${REPO}/.claude/build-loop/gate-logs`

const BUILDER = {
  'rust-transport': { model: 'opus', effort: 'high' },
  rust: { model: 'opus', effort: 'medium' },
  web: { model: 'sonnet', effort: 'medium' },
  docs: { model: 'sonnet', effort: 'low' },
}

const branchOf = (row) => `${row.id.toLowerCase()}-auto`
const titleOf = (row) => `${row.id}: ${row.title.charAt(0).toLowerCase()}${row.title.slice(1)}`
const MERGE_GUARD = `${REPO}/.claude/workflows/merge-guard.sh`
const PUSH_PR = (row) => `git push --force-with-lease -u origin ${branchOf(row)}. If \`gh pr view ${branchOf(row)}\` finds a PR, reuse it. Else run \`gh pr create --base main --head ${branchOf(row)} --title "${titleOf(row)}"\` with a body that says what changed and how it was verified. If the row names GitHub issues as #NNN, end the body with one "Closes #NNN" line for each, so the merge closes them. The title becomes the squash commit on main, so it must keep the form "Y-NNN: <what changed>". No AI attribution anywhere.`

// Owner, 2026-11-09 (Y-694): CI is the gate. The local gate ran one row at a time and repeated CI: Y-649 spent 64 min in it, CI takes 6.
// merge-guard, not \`gh pr checks --watch\`: the latter exits with "no checks reported" in the seconds after a push, and ignores the required names.
// Y-703: the Then commands run on an idle tailnet machine through gate.sh, so they need the pushed commit.
const GATE_SH = `${REPO}/.claude/workflows/gate.sh`
const GATE = (row) => `Push the branch and open its PR first: ${PUSH_PR(row)} Then run the Then commands below and wait for CI, both in one background shell as the next lines say. \`bash ${MERGE_GUARD} <pr number>\` waits until every check on the pushed commit completes, and exits 0 only when all are green and the required checks are present.`

const RULES = (wt) => `
Rules for this run (CLAUDE.md §B7, the build loop):
- Work only inside the worktree ${wt}. Never touch ${REPO} itself.
- Do not edit tracker.md or docs/session-log.md. The ship stage does that.
- Do not create or change anything under docs/adr/, and do not add or change an invariant in a crate tracker. If the row needs either, stop and say so.
- Commit messages are "Y-NNN: <what changed>" and carry no AI attribution of any kind.
- Never run the podman suite, \`just check\`, or Playwright in any form (\`just web-e2e\`, \`npm run e2e\`, \`npx playwright test\`). CI runs them on the PR. Rows run in parallel, and parallel local suites run the box out of memory. The one exception: when your gate includes \`just web-e2e\`, a fix agent may run \`just web-e2e --update-snapshots=changed <spec>\` to regenerate a baseline that its change was meant to alter, and commits the new images. Never regenerate a baseline on the host: its fonts differ. You may run \`just fmt-check\`, \`just lint\`, \`cargo nextest run -p <crate>\` without YANTRA_REQUIRE_PODMAN, and the web lint and unit tests.
- Web code: load the skills vercel-react-best-practices, tanstack-router-best-practices, tanstack-query-best-practices, playwright-best-practices, accessibility, mobile-native, m3-expressive and emil-design-eng before you write any. A screen is designed, not dumped: build it from the web/src/m3 kit with M3 Expressive type, shape, colour and spacing; show what needs the owner first and hide what passed; never show raw probe output or a monospace wall where a designed row fits. Every screen you touch must feel native on a phone: check it at 390 px with touch, safe areas and no hover-only control. Errors are typed and every error path is tested.`

function lock() {
  let tail = Promise.resolve()
  return (fn) => {
    const run = tail.then(fn)
    tail = run.catch(() => {})
    return run
  }
}
// The walk is serial because it builds and serves on one port; shipping is serial so rebases see each other's merges.
const serialWalk = lock()
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
          priority: { type: 'integer', minimum: 0, maximum: 4 },
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
    extraChecks: { type: 'array', items: { type: 'string' }, description: 'commands that prove the done condition and that CI does not run. They run after the push through gate.sh, on an idle tailnet machine or on this box, so none may need podman or Playwright; a test in a CI suite needs no entry. Each must run as written: `yantrad` is binary-only, so use `--bin yantrad` and never `--lib`, and a nextest filter must match a test (check with `cargo nextest list`). Leave it empty when CI already proves the row.' },
  },
  required: ['park', 'plan', 'extraChecks'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    finished: { type: 'boolean', description: 'true only when the log ends in its GATE_EXIT line. false means the gate still runs, and pass then means nothing' },
    pass: { type: 'boolean' },
    failures: { type: 'string', description: 'the failing command and the last 60 lines of its output' },
    flaky: { type: 'array', items: { type: 'string' }, description: 'tests that failed on CI, are in files that `git diff --name-only origin/main...HEAD` does not list, and passed when the failed jobs reran' },
    fixedChecks: { type: 'array', items: { type: 'string' }, description: 'only when a Then command is itself wrong (an unknown target, a filter that matches no test): every Then command, corrected' },
    machine: { type: 'string', description: 'what follows "gate-machine:" in the log, or "none" when the log has no such line' },
  },
  required: ['finished', 'pass', 'failures'],
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

const WALK_SCHEMA = {
  type: 'object',
  properties: {
    needs: { type: 'array', items: { type: 'string', enum: ['web', 'machine'] }, description: 'what `walk.sh needs` printed' },
    shots: { type: 'array', items: { type: 'string' }, description: 'absolute paths of the PNG and TXT files `walk.sh shoot` listed' },
    seen: { type: 'string', description: 'one line per screenshot: what it shows, and any console error from errors.txt' },
    mac: { type: 'string', enum: ['not-needed', 'pass', 'fail', 'unreachable'] },
    failures: { type: 'string', description: 'the failing command and the last 60 lines of its output' },
  },
  required: ['needs', 'shots', 'mac'],
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
Not eligible: anything CLAUDE.md §B7 excludes. That covers rows that need the owner, a phone, a Pi, audio hardware, the Mac's keyboard or screen, Figma or Claude Design, a release cut, a new or amended ADR, or an answer to an open question. A check on a Mac over ssh is eligible: \`ssh biswa@bishwajeets-macbook-pro\` reaches the real Mac.
Also skip: ${exclude.length ? exclude.join(', ') : 'nothing else'}.
Also skip a row that an earlier report in ${REPO}/.claude/build-loop/ parked, unless its reason no longer holds on origin/main.${RETRY.length ? `\nThe owner asked to retry these parked rows, so they are eligible if nothing else rules them out: ${RETRY.join(', ')}. An open PR does not rule a retried row out: it continues on that PR's branch.` : ''}

Priority, from CLAUDE.md §B7: 0 = a row that milestone M18 (the daily driver) lists, 1 = closes or unblocks another open milestone, 2 = a defect or a red suite, 3 = a feature whose dependencies are done, 4 = debt. Ties go to the lower Y-number.
For each eligible row give its kind (rust-transport for ssh, tmux or socket code; rust; web; docs) and the files it will edit: read the code to find them, because a folder such as web/src blocks every other row in it. Put every row you rejected in skipped with one line of reason.`
}

const rank = (rows) => [...rows].sort((a, b) => a.priority - b.priority || Number(a.id.slice(2)) - Number(b.id.slice(2)))
// Rows that edit the same file never run at once; ship rebases one row at a time, so other overlaps resolve there.
const clash = (a, b) => a.paths.some((p) => b.paths.some((q) => p.startsWith(q) || q.startsWith(p)))

// The owner's own services run in podman on this box: a blanket `podman rm -f` took the chat agent down three times on 2026-11-03.
const CLEANUP = `Afterwards remove only the test containers: those with label yantra-fixture (podman ps -aq --filter label=yantra-fixture) and those named yantra-e2e-*. Never stop or remove any other container.`

// Every agent pays a ~50k-token start-up cost (2026-11-02 run), so the stages below share agents where the model rule allows.
// Y-493 parked because the agent read the log tail while the gate still ran, so the run must end in a sentinel line.
// Y-704: a subagent's turn ends before a Monitor fires, so 18 wait agents on 2026-11-10 returned at once and waited for nothing.
const BLOCK = (log, line) => `Wait with a blocking Bash call, not Monitor: \`timeout 570 bash -c "until grep -q '^${line}=' ${log}; do sleep 20; done"\` with the Bash timeout set to 600000. Exit 124 means the line is not there yet: run the same call again, up to 5 times.`
const WAIT = (gateLog) => `${BLOCK(gateLog, 'GATE_EXIT')} Judge pass from GATE_EXIT and the failing tests, never from a partial tail. Return finished=false only after 5 calls end in 124: the run then sends another agent to wait.`
const GATE_HOW = (wt, gateLog) => `CI can take longer than a 10-minute Bash call. Run \`mkdir -p ${GATE_LOGS} && rm -f ${gateLog}\`, then run the Then commands and the merge guard in a background shell: \`( bash ${GATE_SH} run ${wt} '<the Then commands, joined by &&>' && bash ${MERGE_GUARD} <pr number> ) > ${gateLog} 2>&1; echo "GATE_EXIT=$?" >> ${gateLog}\`. Leave out the gate.sh part when Then says nothing more. gate.sh sends the commands to an idle machine on the tailnet, or runs them here when none is idle, and its first line names the machine. ${WAIT(gateLog)}`

// A counter, not the clock, names the log: a prompt that changes on every run defeats the resume cache.
const gateRuns = {}
const nextGateLog = (row, label) => `${GATE_LOGS}/${TODAY}-${row.id}-${label}-${(gateRuns[row.id] = (gateRuns[row.id] || 0) + 1)}.log`

// Y-649 and Y-653 parked on 2026-11-09 with no red test: the gate agent returned before GATE_EXIT, and that counted as a failed round.
async function untilFinished(row, wt, gateLog, label, v) {
  for (let i = 1; v && !v.finished && i <= 6; i++) {
    v = await agent(
      `The gate for ${row.id} in ${wt} runs in the background and writes to ${gateLog}. Do not start it again and do not change any file. If the log does not exist, the gate never started: return finished=true, pass=false. ${WAIT(gateLog)}
${FLAKY}`,
      { label: `wait:${row.id}:${label}:${i}`, phase: 'Build', schema: VERIFY_SCHEMA, model: 'sonnet', effort: 'low' },
    )
  }
  if (v && !v.finished) return { ...v, pass: false, failures: `The gate did not finish in 6 waits. Log: ${gateLog}` }
  return v
}

// A slow-network test outside the diff parked Y-585, so a failure outside the diff gets one rerun before it counts.
const FLAKY = `When a check fails, find its run with \`gh pr checks <pr number>\` and read the failed job log with \`gh run view <run-id> --log-failed\`. Put the failing check, its run id and the last 60 lines of the failing test's output in failures. A failure is a retry, not a failure, when its test file is outside \`git diff --name-only origin/main...HEAD\`: rerun the failed jobs once with \`gh run rerun <run-id> --failed\`, then truncate the log, run the merge guard into it again in a background shell, and wait as before. If every failure is like that and the rerun passes, report pass=true and list those tests in flaky. Any other failure keeps pass=false.`

// A web or docs row is built by Sonnet, so one Sonnet agent can run the gate and fix what it finds.
async function verifyAndFix(row, wt, plan, label, attempts) {
  const gateLog = nextGateLog(row, label)
  return untilFinished(row, wt, gateLog, label, await
    agent(
      `Run the CI gate for ${row.id} in ${wt}, fix what fails, and report whether it passes at the end.
Gate: ${GATE(row)}
Then: ${plan.extraChecks.join(' && ') || 'nothing more'}
${GATE_HOW(wt, gateLog)} Each rerun of the gate writes to the same log: truncate it first.
If a check fails, read its failed job log, find the cause, fix the code, run the fast local checks for it, commit, and run the gate again: it pushes the fix. Stop after ${attempts} gate runs.
${FLAKY} Do not change code for a flaky test.
A screenshot that the row's change was meant to alter: regenerate it with \`just web-e2e --update-snapshots=changed <spec>\` and commit the images. A screenshot it was not meant to alter is a regression: fix the code.
If a Then command fails before any test runs because the command is wrong, not the code, correct it and return the corrected list as fixedChecks.${RULES(wt)}`,
      { label: `gate:${row.id}:${label}`, phase: 'Build', schema: VERIFY_SCHEMA, model: 'sonnet', effort: 'medium' },
    ),
  )
}

async function verify(row, wt, plan, label) {
  const gateLog = nextGateLog(row, label)
  return untilFinished(row, wt, gateLog, label, await
    agent(
      `Run the CI gate for ${row.id} in ${wt} and report whether it passes. Do not change any file.
Gate: ${GATE(row)}
Then: ${plan.extraChecks.join(' && ') || 'nothing more'}
If a Then command fails before any test runs because the command is wrong, not the code, correct it, run the corrected one, judge pass on that, and return the corrected list as fixedChecks.
${GATE_HOW(wt, gateLog)}
${FLAKY}`,
      { label: `verify:${row.id}:${label}`, phase: 'Build', schema: VERIFY_SCHEMA, model: 'sonnet', effort: 'low' },
    ),
  )
}

async function fix(row, wt, what) {
  const b = BUILDER[row.kind]
  return agent(
    `Fix ${row.id} in ${wt}. ${what}
When CI failed, find the run with \`gh pr checks ${branchOf(row)}\` and read its failed job log with \`gh run view <run-id> --log-failed\`. Find the cause before you change code. Commit the fix and do not push: the next gate pushes it and CI tests it. Run only the fast local checks. ${CLEANUP}${RULES(wt)}`,
    { label: `fix:${row.id}`, phase: 'Build', model: b.model, effort: b.effort },
  )
}

const gateMachine = {}
const noteMachine = (row, v) => {
  if (v?.machine && v.machine !== 'none') gateMachine[row.id] = v.machine
}

async function verifyUntilGreen(row, wt, plan, rounds) {
  if (DRY) return (log(`${row.id}: dry run, so no push and no CI gate`), true)
  const selfFix = row.kind === 'web' || row.kind === 'docs'
  if (selfFix) {
    const v = await verifyAndFix(row, wt, plan, 'g', rounds)
    noteMachine(row, v)
    if (v?.fixedChecks?.length) plan.extraChecks = v.fixedChecks
    if (v?.flaky?.length) log(`${row.id}: retried outside its diff, passed alone: ${v.flaky.join(', ')}`)
    return !!(v && v.pass)
  }
  for (let i = 1; i <= rounds; i++) {
    const v = await verify(row, wt, plan, String(i))
    noteMachine(row, v)
    // A wrong check is the plan's bug, and no code fix can make it pass.
    if (v?.fixedChecks?.length) plan.extraChecks = v.fixedChecks
    if (v?.flaky?.length) log(`${row.id}: retried outside its diff, passed alone: ${v.flaky.join(', ')}`)
    if (v && v.pass) return true
    if (i === rounds) return false
    if (v) await fix(row, wt, `The gate failed:\n${v.failures}`)
  }
  return false
}

// Y-660: the gate runs against the fixture, so a visible row is also walked on the real product, and a machine row
// also runs on the real Mac. walk.sh holds the paths that decide which, and its guard refuses the merge without it.
const WALK = `${REPO}/.claude/workflows/walk.sh`
const WALK_WAIT = (log) => `${BLOCK(log, 'WALK_EXIT')} Never return while it runs.`
async function walk(row, wt) {
  return serialWalk(() =>
    agent(
      `Walk ${row.id} in ${wt} on the real product. Do not change any tracked file.
1. Run \`bash ${WALK} needs ${wt}\`. Return its lines as needs. If it prints nothing, return needs=[], shots=[], mac=not-needed and stop.
2. Run \`bash ${WALK} up ${wt}\`. It builds the branch's yantrad and dashboard and serves them against the real fleet on a spare port. A cold build takes longer than a Bash call, so run \`mkdir -p ${wt}/.walk && rm -f ${wt}/.walk/up.log\`, then in a background shell \`( bash ${WALK} up ${wt} ) > ${wt}/.walk/up.log 2>&1; echo "WALK_EXIT=$?" >> ${wt}/.walk/up.log\`. ${WALK_WAIT(`${wt}/.walk/up.log`)} Go on only when WALK_EXIT=0.
3. Read \`git diff origin/main...HEAD\` and web/src/router.ts, and choose the routes that show what the row changed. For a machine row, choose the screens that show that path: the fleet, the machine's page, or the Chat. Run \`bash ${WALK} shoot ${wt} <route>...\`. Only open pages; never press a control that writes, because the machines are real.
4. Read every PNG and TXT file it lists with the Read tool, and read ${wt}/.walk/shots/errors.txt. Describe each screen in seen.
5. Always run \`bash ${WALK} down ${wt}\`, also after a failure.
6. If needs has machine, run \`( bash ${WALK} mac ${wt} ) > ${wt}/.walk/mac.log 2>&1; echo "WALK_EXIT=$?" >> ${wt}/.walk/mac.log\` in a background shell. ${WALK_WAIT(`${wt}/.walk/mac.log`)} WALK_EXIT=0 is pass, WALK_EXIT=2 is unreachable, any other value is fail. Put the tail of ${wt}/.walk/test-mac.log in failures. Else mac=not-needed.
${CLEANUP}`,
      { label: `walk:${row.id}`, phase: 'Build', schema: WALK_SCHEMA, model: 'sonnet', effort: 'low' },
    ),
  )
}

// Returns the walk, or a reason to park. A failing Mac run is red like the gate, so it gets one fix.
async function walkUntilGreen(row, wt, plan) {
  for (let i = 1; ; i++) {
    const w = await walk(row, wt)
    if (!w) return 'the walk agent died'
    if (w.needs.length && !w.shots.length) return `a ${w.needs.join(' and ')} row needs screenshots, and the walk took none: ${w.failures || ''}`
    if (w.mac === 'unreachable') return 'the row needs the real Mac, and it is unreachable'
    if (w.mac !== 'fail') return w
    if (i === 2) return `just test-mac stayed red: ${w.failures || ''}`
    await fix(row, wt, `\`just test-mac\` failed on the real Mac:\n${w.failures || ''}`)
    if (!(await verifyUntilGreen(row, wt, plan, 2))) return 'the gate went red after the test-mac fix'
  }
}

const shown = (w) =>
  w.needs.length
    ? `\nThe walk ran the branch on the real fleet. Read each screenshot and each text file with the Read tool and judge them against the row's outcome in tracker.md: ${w.shots.join(', ')}. Check the copy word by word in the text files, never only in an image: an eye reading a screenshot corrects a misspelt word. A wrong or misspelt word, a layout broken at 390 px, an error or an empty screen where the row expects content is blocking. Load the m3-expressive skill and judge the design too: raw text dumps, monospace walls, unstyled lists, weak hierarchy, cramped or uneven spacing, or detail the owner does not need shown before what needs the owner is blocking. The walker saw: ${w.seen || 'nothing noted'}.${w.mac === 'pass' ? ' `just test-mac` passed on the real Mac.' : ''}`
    : ''

async function runRow(row) {
  const branch = branchOf(row)
  const wt = `${WT_ROOT}/${branch}`
  const park = (reason) => ({ id: row.id, title: row.title, status: 'parked', reason, branch, gateMachine: gateMachine[row.id] || 'none' })

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
  let w = await walkUntilGreen(row, wt, plan)
  if (typeof w === 'string') return park(w)

  const REVIEW_RULE = `Put every finding in blocking or minor; none may be dropped. A finding is blocking when it makes the feature fail on a platform the row or the crate targets, stalls or drops the user's work, leaves state wrong after a failure, leaks a secret or private text, or breaks a crate invariant or a CLAUDE.md rule. Anything you would call "should hold the merge" is blocking. Only style, cost, cleanup and unlikely edge cases are minor. Do not change any file.`
  let r = await agent(
    `Review the change for ${row.id} in ${wt} (git diff origin/main...HEAD). You did not write it.
Load the code-review skill and review at high effort, with the target \`${wt}\` named explicitly: a review run without it reads the main checkout. Check it against the row's done condition in tracker.md and against the invariants of each crate it touches.${shown(w)}
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
    w = await walkUntilGreen(row, wt, plan)
    if (typeof w === 'string') return park(w)
    r = await agent(
      `Re-check the change for ${row.id} in ${wt}. You did not write it. An earlier review blocked it on:\n${issues}\n
Read the fix (git diff ${base}..HEAD) and the code each point names. For each point, decide if the fix resolves it. Also report any new defect the fix brings in. Do not review the rest of the change again.${shown(w)}
${REVIEW_RULE}`,
      { label: `review:${row.id}:${fixes + 1}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'opus', effort: 'medium' },
    )
  }
  if (!r) return park('the reviewer died')

  const title = titleOf(row)
  // The merge guard waits for CI on the rebased commit, so a rebase needs no gate of its own.
  const ship = () =>
    serialShip(() =>
      agent(
        `Ship ${row.id} from ${wt}, branch ${branch}. CI passed on the branch.
0. git fetch origin and rebase on origin/main. Resolve conflicts in tracker.md and docs/session-log.md by keeping both sides and deduplicating by Y-number. Do not change any other file except to resolve a conflict. If a conflict in any other file cannot be resolved, abort the rebase and return failed.
1. In tracker.md set the ${row.id} row to 🔵 review and add "**Merged ${TODAY}** by the build loop." with one line on what shipped. A row does not close in its own PR: a later release PR marks it ✅ done. Update the row; never add a second one. Then check: grep -oE '^\\| Y-[0-9]+ \\|' tracker.md | sort | uniq -d prints nothing. Skip this step if the row already says it.
2. Append one entry to docs/session-log.md for ${TODAY}, in the style of the entries above it. Plain prose, CLAUDE.md §A6. Skip this step if the entry exists.
3. Commit "${row.id}: record the change in the tracker" if steps 1–2 changed anything.${DRY ? `
4. Dry run: do not push. Return status open.` : `
4. Push the branch: ${PUSH_PR(row)}
5. ${w.needs.length ? `Run \`bash ${WALK} publish ${wt} <pr number>\`. It posts the walk's screenshots on the PR. If it fails, return failed with its output. ` : ''}Run exactly one command: bash ${WALK} guard <pr number> && bash ${REPO}/.claude/workflows/merge-guard.sh <pr number> --merge "${title} (#<pr number>)". The merge guard merges only when every check is green; never call \`gh pr merge\` yourself. The walk guard exits non-zero when the PR changes a screen or a machine path and has no walk comment. The merge guard waits for every check on the rebased commit and exits non-zero unless all are green. Run it bare: do not pipe it, redirect it or wrap it, because a pipe hides the guard's exit code and the merge then runs on a red check (Y-646). Never merge outside this command, and never call a red check unrelated. If the walk guard fails, return failed with its output. If the merge guard fails, return checks-failed with the failing check's log tail.
6. If GitHub says the branch is behind, return status behind; do not rebase here, because a rebase runs before the tracker step.
7. After a merge, run git worktree remove ${wt} from ${REPO} and delete the local branch.`}`,
        { label: `ship:${row.id}`, phase: 'Ship', schema: SHIP_SCHEMA, model: 'sonnet', effort: 'medium' },
      ),
    )

  let s = await ship()
  if (s && s.status === 'checks-failed') {
    await fix(row, wt, `CI failed on the PR ${s.pr || ''}:\n${s.failures || ''}`)
    if (!(await verifyUntilGreen(row, wt, plan, 2))) return { ...park('CI failed and the fix stayed red'), pr: s.pr }
    w = await walkUntilGreen(row, wt, plan)
    if (typeof w === 'string') return { ...park(w), pr: s.pr }
    s = await ship()
  }
  if (s && s.status === 'behind') s = await ship()
  if (!s) return park('the shipper died')
  return { id: row.id, title: row.title, status: s.status, pr: s.pr || '', reason: s.failures || '', branch, gateMachine: gateMachine[row.id] || 'none' }
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
Then a table: row, title, outcome, PR, the machine that ran its gate (gateMachine), and for parked rows the reason and the branch that holds the work.
Then the rows triage skipped, one line each.
Results: ${JSON.stringify(results)}
Skipped: ${JSON.stringify([...skipped].map(([id, reason]) => ({ id, reason })))}`,
  { label: 'report', phase: 'Report', model: 'sonnet', effort: 'low' },
)

return { report: REPORT, results, skipped: [...skipped].map(([id, reason]) => ({ id, reason })) }
