# R24 — An audit of every decision and practice against daily use

**Asked 2026-11-08 by the owner ([#645](https://github.com/2002Bishwajeet/yantra/issues/645)), built
as Y-659.** The owner said: "we should audit everything — are the practices and the decisions we
made good or not? We keep finding too many things even after working for so long." Today's trigger:
background work that Claude starts in the Chat dies at the end of each turn. The owner also said on
2026-11-05 that Yantra is not usable daily, and on 2026-11-08 that the phone does not feel native.

- **The goal it is judged against:** the owner's daily coding loop from the phone, from an issue to a
  merged PR, on the real machines (the box, the Mac, the laptop), with a Chat as good as T3 Code's.
  The repo's own reasons for a decision are not evidence that the decision is good.
- **Read against:** `main` at `6c7d7ea6`; open PRs #643 (ADR-0040) and #646 (ADR-0041); T3 Code at
  `67eebaca` in `~/Github/t3code-ref`; the build-loop reports for 2026-11-03 to 2026-11-05.
- **How:** five read-only passes (ADR-0001 to 0016, 0017 to 0025, the Chat ADRs against T3, 0027 to
  0040, and a trace of every fault since 2026-11-04). I then checked each loud claim against the
  file and line it cites. A claim I could not check says so.

## Summary

**Of 32 product faults found since 2026-11-04, CI, the gate and the reviewers found none.** The
owner, the first live walk (Y-637), the fresh-install captures (Y-613) and the gap audit found all 32.

**The three biggest causes:**

1. **Nothing that runs before a merge touches the real product.** Every check runs against a stand-in:
   a Node fake of the daemon, a Linux container with bash 5, and tidy fixture JSON. Nine real-Mac
   tests exist, and nothing runs them. That is how the Chat stayed dead on the Mac for 29 days
   (Y-634) while every suite stayed green.
2. **No person looks at a screen or a flow before it ships, and the release walk never happens.** The
   smoke pass moved from one release to the next nine times. Four releases shipped in 29 hours, and
   97 PRs merged in three days. The reviewer reads a diff and accepts "proved by a test" as done.
3. **The core decisions were made for a CLI on a laptop, and they were not revisited when the
   phone became the client.** The daemon persists nothing. Claude runs one process per turn. The
   CLI comes first. A workspace is bound to one machine. These four decisions cause the hex-id
   thread list, the resume by newest file, the background-work death and the empty history when a
   machine sleeps. T3 already showed the answer, and our research notes cited the T3 commits that
   held it.

A fourth cause makes the other three worse. **Breadth shipped while the core loop was broken.** Rooms,
the microphone, layout sync, the box TUI and the history extractor all merged while the Chat on the
Mac was dead. The M16 merge rows (Y-495 to Y-497) are still not built.

**The three most important changes:**

1. **A row that the owner can see merges only with proof from the real product.** The build loop
   runs the branch against the real fleet, drives the changed screen in WebKit at 390 px, and
   attaches the screenshots to the PR. It runs the Mac tests when a row touches the Mac's code
   path. Code enforces this, not prompt prose. A release waits for a recorded walk.
2. **Freeze breadth until the owner calls Yantra a daily driver.** The loop builds only rows on an
   allowlist: M16, the Chat parity rows, walk findings and defects. M17, rooms, the microphone,
   placement and the ADR-0040 agent grant wait.
3. **Give the Chat a store and a process for each thread.** One new ADR lets the daemon keep a
   small SQLite file of its own thread state (session id, title, turns, background tasks). Accept
   ADR-0041 only after the six fixes in §2.3. Make the chat socket survive a phone sleep.

**Loud, and outside the three:** any process on the hub can act as the owner. It sends a forged
`X-Forwarded-For` to the daemon's own address (`crates/yantrad/src/write.rs:82-101`). Since
2026-11-04, agent sessions run on the hub under a separate account (Y-627, Y-628). So a
prompt-injected agent there can get every owner write, including merges with the daemon's
GitHub token. See ADR-0017 in §2.

---

## 1. Why faults escape

### 1.1 Two common guesses are wrong

- **"The gate tests only what changed" let through no fault.** A full run of every suite would
  also have passed all 32, because the full suites test the same fakes.
- **"The e2e suite runs at desktop width only" is false.** CI runs phone (390 × 844, touch), tablet and
  desktop on every web PR (`web/playwright.config.ts:56-60`, `web/e2e/lib/sizes.ts:4-9`,
  `.github/workflows/web.yml:64`). The phone runs pass because they check layout against short
  fixture data in Chromium. They never run in WebKit, the engine of the owner's iPhone.

### 1.2 The faults, and the cause that let each one through

The cause letters are defined under the table. "Lived" is time on `main` before someone found it.

| # | Fault | Introduced | Found | Lived | Primary | Secondary |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Every Chat turn on the Mac fails under bash 3.2 | #405, 10-06 | Y-634 | 29 d | D | E |
| 2 | Background work dies at the end of the turn | #405; ADR-0035 d3 (#450) | #644, 11-08 | 33 d | I | E |
| 3 | The Mac reads "not signed in" when it is | #171, 08-05 | Y-619 | 91 d | D | J |
| 4 | The Mac needs a hand step to start tmux | ADR-0018, 08-03 | Y-632 | 93 d | I | D |
| 5 | Mac hooks fail: `node` not on `PATH` | ADR-0018 | Y-640 | ~3 mo | D | C |
| 6 | A Mac session reads "unclear"; raw pane status | #250, 09-07 | Y-639 | 58 d | D | C |
| 7 | The Mac shows asleep while the owner types on it | #18, 07-30 | Y-626 (open) | 97 d+ | C | D |
| 8 | Tailscale SSH's raw check text; stale host key | #529, 10-31 | Y-621 | 4 d | L | F |
| 9 | New session on the hub: "Permission denied" | #585, 11-04 | Y-627 | <1 d | H | E |
| 10 | The hub offered in Add a device | #585 | Y-614 | hours | H | K |
| 11 | The hub listed in Setup with a join command | #585 | Y-622 | hours | H | L |
| 12 | Setup contradicts itself on a fresh install | #250, #462 | Y-615 | ~58 d | L | J |
| 13 | "Check again" on a machine never checked | #250 | Y-616 | 58 d | J | L |
| 14 | "present on 0 of 0 machines"; a placeholder card | #250 | Y-617 | 58 d | J | L |
| 15 | Stale copy: rooms, `daemon.env`, "All set" on an empty fleet | #497, #584 | Y-618 | 0–15 d | J | K |
| 16 | A refused GitHub grant reads "signed in" | #250 | Y-623 | 58 d | K | L |
| 17 | A revoked grant shows only in About | M14 | Y-606 | weeks | K | F |
| 18 | Every child process inherits the daemon's tokens | #251, 09-07 | Y-647 | 59 d | I | H |
| 19 | No log line when the grant changes state | — | Y-648 | — | G | F |
| 20 | A slow update shows no progress | — | Y-612 | — | F | E |
| 21 | Organisations with OAuth limits hide repos | — | Y-629 (open) | — | C | F |
| 22 | New session's Start step reads like a log | M14 | Y-630 | ~58 d | J | G |
| 23 | The error surface cuts the cause and the fix | M14 | Y-631 | — | J | L |
| 24 | Chat: two empty states, a git bar with nothing to act on | #490, #504, #558 | Y-633 | 0–15 d | J | G |
| 25 | Create and open lands on "not found" for 30 s | #250 | Y-638 | 58 d | C | F |
| 26 | Counts disagree between pages | many | Y-641 | — | K | H |
| 27 | Phones offered as session machines | — | Y-642 | — | K | J |
| 28 | The directory step: path rejected, a 5,200 px list at 390 | — | Y-643 | — | L | B |
| 29 | Hex ids, uuids and raw tmux text on the session page | — | Y-644 (open) | — | J | G |
| 30 | Small faults: 15 px overflow at 390 a day after a "fit to phone" row | various | Y-645 (open) | — | L | B |
| 31 | The Chat is far behind T3 | #405 onward | Y-649 to Y-655 | ~30 d | G | J |
| 32 | The phone does not feel native | M14 onward | owner, 11-08 | — | J | H |

**The causes.** A: the gate tests only changed files. B: the phone size missed it. C: a fake stood
in for ssh, tmux, the daemon or GitHub. D: CI's OS or shell differs from the real machine. E: the
loop merges with no one using the product. F: no live walk before the release. G: the row names
code, not what the owner sees. H: the reviewer read a diff, not the running app. I: an ADR is wrong.
J: no person judged the copy or the screen. K: two parts of the product disagree, and no test
compares them. L: fixture data is not real data.

| Cause | Primary | Secondary |
| --- | --- | --- |
| J, no person judged the screen | 8 | 4 |
| D, CI is not the real machine | 4 | 2 |
| L, fixture data is not real data | 4 | 5 |
| K, parts disagree | 4 | 2 |
| I, a wrong ADR | 3 | 0 |
| C, a fake above the seam | 3 | 2 |
| H, the reviewer read a diff | 3 | 3 |
| G, a code task, not an outcome | 2 | 3 |
| F, no walk | 1 | 5 |
| E, no one used it | 0 | 4 |
| B, phone size missed | 0 | 2 |
| A, changed files only | **0** | **0** |

Grouped, **"no one touched the real thing"** (C, D, L, E, F) is the primary cause of 15 faults and a
secondary cause of 18. **"No one judged the screen"** (J, H) is the primary cause of 11. E and F
are under-counted as primaries: with a walk at each release, most of the others would have lived
days, not months.

### 1.3 Process faults: the loop broke its own rules

- **The loop merged on red twice.** #568 merged with `web` red on 11-03, because the agent ran the
  check with `;` before the merge (Y-609). #623 merged on a red `e2e (phone 2/2)` on 11-04,
  because the ship agent piped the guard through `tail` (Y-646). The 11-04 report says: "Nobody read
  the e2e log." Both rules were prompt prose. Each fix added more prose.
- **Parked rows were shipped by hand.** The loop parked Y-493, Y-611 and Y-633. A session then
  merged each one: #558, #589 ("The next loop run is the proof") and #637. #637 keeps the header
  that the owner's done condition said to fold into one bar, and the row is ✅ done anyway.
- **Rows that name the Mac closed with no run on the Mac.** The done condition of Y-619, Y-632,
  Y-639 and Y-640 names `bishwajeets-macbook-pro`. Each PR says "the gate passed" or "CI checks". No
  PR body and no session-log entry claims a run on the Mac (`docs/session-log.md:394,398,399,403`).
- **The walk rule shipped as prose, and the next release ignored it.** #620 added "a release waits
  for a clean walk" to CLAUDE.md §B7 on 11-04. `.claude/workflows/build-rows.js` has no walk step,
  and its row Y-637 is ⬜. v0.10.3 (#642) was cut about 11 hours later with no walk.
- **The gate's premise is stale.** `build-rows.js:33` and `:35` say "CI runs the full suites on the
  PR", and the flake rule at `:161` relies on it. That stopped being true when #561 (Y-607) made CI
  skip the jobs a PR does not touch.
- **Flakes are retried, not fixed.** Playwright retries once in CI (`web/playwright.config.ts:25`).
  The loop's flake rule passes a test outside the diff that passes alone. T3's rule is the opposite:
  "flaky tests are fixed, not retried" (T3 `AGENTS.md`, Verifying).

### 1.4 What each step really checks

- **The gate** (`build-rows.js:35-38`) runs fmt, clippy and nextest for the changed crates, and lint,
  tsc, vitest and the covering e2e specs for web. Builders may not run Playwright or podman
  (`:46`), so a web builder never sees its own screen.
- **Screenshots are judged by their author.** The gate agent regenerates a baseline when "the row's
  change was meant to alter" it (`:174`). No one else looks at the new image.
- **The e2e suite runs against a fake.** `web/e2e/fixture/server.mjs` is 1,096 lines of Node. It
  says of itself: "Nothing here is the daemon's logic — writes mutate an in-memory copy so the next
  read agrees with them" (`:1-4`). The real read model lags by 30 s (fault 25). The fake cannot.
- **CI never runs a Mac.** Every test job runs on `ubuntu-24.04`. macOS appears only in
  `release.yml:105,110`, to build binaries. Y-635 added bash 3.2 and dash in a container. That
  catches a parse error, not the keychain, `launchd` or BSD `tail`.
- **The real-machine tests exist and nothing calls them.** `just test-mac` (`justfile:57-58`) runs
  nine `#[ignore]` tests in `crates/yantra-core/tests/manual_macbook.rs`. No CI job, no loop stage
  and no smoke-pass check calls it. It has no Chat-turn test.
- **The reviewer is told to read the diff** (`build-rows.js:256-258`). `doneMet` means "met and
  proved by a test" (`:121`). Nothing tells it to run the app, look at a screenshot or ssh to the Mac.
- **The smoke pass's twins are weak.** Check 8 (a permission card) names `Full access draws no
  permission card` as its twin. The file itself says "no test draws a permission card or presses
  Stop in the browser" (`docs/plans/smoke-pass.md`). The pass moved on at every release from Y-610
  to Y-656, and at each release from Y-438 to Y-548 before that.

### 1.5 What T3 does instead

T3 has the same problem — agents write most of its code — and answers it with practice, not prose.
From T3's `AGENTS.md` (Verifying, Test data, Pull requests) and `.agents/skills/test-t3-app`:

- "User-visible frontend changes should get one integrated pass in a real client." The agent drives
  T3's own browser panel against a running dev server.
- "An empty database is a bad test." Each worktree is seeded with a copy of the developer's real data.
- A free `Replay (dev)` provider replays recorded turns through the real adapter, so a turn can be
  watched without paying for a model.
- "UI changes need before/after images. Motion or timing needs a short video."
- "Flaky tests are fixed, not retried", and lint rules forbid timeouts, sleeps and polling in tests.

Yantra has none of these. That is the main finding of this section.

---

## 2. Each ADR: keep, amend or supersede

**Freeze** means keep the code but stop building on it until the daily loop works. ADR-0003 does
not exist (deleted in 1496519d, Y-083).

| ADR | Verdict | Reason |
| --- | --- | --- |
| 0001 Nygard ADRs | **Amend** | Blockquotes now reverse decisions, so no one place states the decision (0016, 0024). |
| 0002 The name | Keep | No cost. |
| 0004 Rust; the daemon persists nothing | **Amend** | Keep Rust. The "persists nothing" rule (Y-044) is the root of the Chat's identity and history faults. |
| 0005 Logic in `yantra-core` | Keep | Sound. Stop claiming `yantrad` holds no logic: `chat.rs` is 7,892 lines. |
| 0006 ssh exec envelope | Keep | Measured, stable, small. |
| 0007 Workspace schema | **Amend** | One required machine per workspace works against the machine choice and adds a step to New session. |
| 0008 Withdraw the watchdog | Keep | It removed a real bug. |
| 0009 Machine names are ssh destinations | Keep | Same choice as T3's `ssh -G`. See the hub note below. |
| 0010 Drop `branch` | Keep | Correct; worktrees came as it said. |
| 0011 Claude as a TUI in tmux, no input | **Supersede** | "No headless path" and "Yantra sends no input" are false. The Chat is the daily surface. |
| 0012 CLI and daemon call one library | **Supersede** | All three of its own revisit triggers have fired (`0012:60-69`). |
| 0013 The heartbeat | **Supersede** | About 4,000 lines rank a fleet where no Mac sends a beat (Y-502, Y-626). |
| 0014 React with the compiler | Keep | Same stack as T3. |
| 0015 Resume forks the conversation | **Supersede** | Both premises are gone once the daemon stores a session id. |
| 0016 Tailscale identity authorises writes | **Amend** | Good for one owner, but the rule is spread over four ADRs and four blockquotes. |
| 0017 The forwarded address is the caller | **Amend** | Its premise — "a local process can already do everything" — broke when agents moved onto the hub. |
| 0018 tmux server carries the macOS login | **Amend** | The domain insight is right. The enforcement is a check at five call sites, and Chat skips it. |
| 0019 A probe is a POST | Keep | Cheap and correct. |
| 0020 Raw write only from broken to valid | Keep | Cheap. Low daily value. |
| 0021 The relay goes in an environment file | **Amend** | The environment leaked both tokens to every child for 59 days (Y-647). |
| 0022 A socket may address a session | Keep | tmux keeps the session when a phone drops. Better than T3. |
| 0023 The GitHub grant beside the relay | **Amend** | The token now merges into every private repo. Least privilege needs a second look. |
| 0024 Material 3 built by hand | **Amend** | It turns every T3 copy into a port, against the owner's 2026-10-06 rule. |
| 0025 The daemon remembers what it pushed | **Amend** | Still "proposed" two months after it shipped. The list empties at each update. |
| 0026 The Chat is a stream-json bridge | **Amend** | Keep the bridge. Decision 2 (one process per turn) is wrong. |
| 0027 The appliance pulls its own update | Keep | Used at every release. |
| 0028 Install the bare minimum | **Amend** | Its `sudo -n` path cannot work under Y-628's non-sudo account. |
| 0029 A machine joins itself | **Amend** | "The account is whoever ran it" conflicts with Y-628. Y-632's LaunchAgent is not recorded. |
| 0030 The one-off sudo terminal | **Supersede** | Its only job is a sudo password. The joined account has no sudo. |
| 0031 The microphone as a virtual source | **Supersede** | It feeds the TUI, not the Chat (Y-651). Worst value per line in the repo. |
| 0032 Encrypted history on the appliance | **Freeze** | The title still says "encrypted" after encryption was dropped. No archive exists. |
| 0033 ACP for other harnesses | Keep | T3 made the same split. Add a row for delegates. |
| 0034 The coding loop writes to GitHub | Keep | The loop itself. Finish Y-495 to Y-497 first. |
| 0035 A chat turn outlives its pipe | **Amend** | Its keeper is Yantra's real edge over T3. Decision 3 caused today's fault. |
| 0036 Layout syncs through the daemon | **Freeze** | Nothing in `web/src` reads `/api/layout`. |
| 0037 Continue is a handoff (proposed) | Amend before accepting | A sleeping source can hand off nothing. Leave it parked. |
| 0038 Rooms and guest devices | **Freeze** | No daily use. Keep decision 6, the read gate. |
| 0039 A room is a shared project | **Freeze** | Eight rows open, no daily use. |
| 0040 An agent caller is tagged (proposed) | Amend before accepting | It leaves the forwarded-header hole open. Split it. |
| 0041 A keeper holds the thread (proposed) | Amend, then accept | Right direction. Six gaps, in §2.3. |

**Count:** 13 keep, 17 amend, 6 supersede and 4 freeze, across 40 ADRs (the three proposed ones
included). That is too many changes to make at once. §4 ranks them.

### 2.1 Decisions that made Yantra worse than T3 for the owner

- **One Claude process per turn (0026 d2, 0035 d3).** T3 keeps one `query()` per thread fed by a prompt
  queue (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1181-1187`, `:1277`). It
  tracks background tasks and keeps the process for 4 hours after the last activity.
- **No store (0004's Y-044 amendment).** T3 keeps an event store in SQLite
  (`apps/server/src/persistence/OrchestrationEventStore.ts`). Yantra resumes the newest transcript by
  file time (`crates/yantra-core/src/logs.rs:284-289`, used at `claude.rs:251`). Any other `claude`
  run in that worktree changes which conversation the next turn resumes. Thread titles have nowhere
  to live, so the list shows hex ids (Y-649).
- **The chat socket does not survive a phone sleep.** The terminal socket pings
  (`crates/yantrad/src/terminal.rs:354`). The chat socket does not. The browser retries five times
  over 23 s (`web/src/api/chat.ts:142`) and then shows `closed`. No `visibilitychange` probe exists
  on the chat. T3 has a supervisor for this case (`docs/internals/connection-runtime.md:21`: "The
  OS can kill a suspended socket without a close event"). **No tracker row covers this.**
- **Hand-built Material (0024 §1).** T3's `components/ui` primitives cannot be copied, only
  ported. About 4,600 lines of "copied" Chat files were rewritten. Hover is not gated for touch
  (`web/src/m3/tokens.css:604`), so a tapped control keeps its hover layer on iOS.
- **The microphone (0031).** T3 turns speech into text on the phone and puts it in the composer
  (`apps/mobile/src/features/voice-input/`). Yantra sends PCM to a PipeWire source on the machine
  for the TUI, and the Chat has no voice.
- **Secrets in the environment (0021, 0023).** T3 reads 0600 files itself
  (`apps/server/src/auth/ServerSecretStore.ts`). Yantra's fix (`crates/yantra-core/src/lib.rs:67-77`)
  is a rule that every new spawn must remember.

### 2.2 Decisions that cost a lot for little daily value

| Decision | Approximate cost | Daily use |
| --- | --- | --- |
| 0013 heartbeat and placement | 4,000 lines; `yantra-agent`; `why.rs` | None. No Mac sends a beat. R5's test (do signals change a winner?) never ran. |
| 0031 microphone | 1,800 lines; 18 review findings; a podman flake | None in the loop. |
| 0032 history | 2,550 lines (`history.rs`, `extract.rs`) | None. Its one reader is a dataset tool. |
| 0038 and 0039 rooms | 4,000+ lines; 8 open rows | None. |
| 0036 layout sync | 845 lines | None. No reader. |
| 0012 CLI parity | `crates/yantra/src/main.rs` is 5,398 lines | Verbs exist only to satisfy the rule (`yantra layout`). |

These add up to about 18,000 lines of Rust and web. Most of them were built between
2026-10-06 and 2026-11-04, while the Chat on the Mac did not work: the microphone (#401 to #414),
history (#400, #416), rooms (#493, #497, #576), the box (#534 to #542), layout (#577), the TUI
(#579) and the extractor (#565).

### 2.3 The changes, one paragraph each

**ADR-0001 and the amendment practice.** CLAUDE.md §B5 allows a dated blockquote when a premise
changes. In practice blockquotes now reverse decisions. ADR-0016's open reads were reversed by its
2026-10-20 blockquote, and ADR-0024 carries six amendments. A reader must now merge the text with its
blockquotes. That is the "one place to read the decision" ADRs exist to give. Write the rule down: a
changed premise gets a blockquote, and a reversed decision gets a new ADR. After two blockquotes,
write a consolidated ADR. T3's rule is stronger: "rewrite or remove the affected text. Do not append
another account."

**ADR-0004, the "persists nothing" amendment.** Supersede it with an ADR that lets the daemon keep
one small SQLite file of its own state: threads, Claude session ids, titles, turns, background
tasks and the notification ring. It holds no secret and no fleet fact that can be derived. Six later
ADRs already bend the rule (0021, 0025, 0032, 0036, 0039, and the keeper registry). The cost of
not storing shows up as faults: resume by newest file, hex-id threads, no history while a machine
sleeps, and notifications lost at each update. This is the lever behind Y-649, Y-655 and ADR-0041.

**ADR-0007.** Make `machine` a default, not the workspace's identity. A thread then carries the
machine it runs on. This removes a step from New session (Y-655) and matches T3, where a thread
picks its environment.

**ADR-0009 and the hub.** One pass proposed that the hub run its own sessions without ssh. **I
disagree.** The owner asked on 2026-11-04 that agents run as a separate non-sudo account (Y-628).
ssh to that account on the hub gives the account boundary. A local exec would run the agent as the
daemon's own user, which can read `daemon.env`. Keep ssh to self. Fix its cost instead: Setup must
make the hub's `karigar` join one step (Y-627, Y-628).

**ADR-0011.** Write a short ADR that says the Chat's structured stream is the control path, and the
TUI in tmux is the attach view. Today ADR-0011 still says there is no headless path and Yantra sends
no input, with no pointer to ADR-0026.

**ADR-0012.** Supersede it. The daemon on the box is the one owner of fleet state. The CLI and the
phone are its clients. The CLI may fall back to the library only when no daemon answers. Today the
laptop's CLI and the box's daemon read different workspace files and different `~/.ssh/config`
files, so one name can mean two hosts. Drop "no UI until the CLI is good" from the tracker's
guardrails: the phone is the primary client.

**ADR-0013.** Supersede it. Its main premise was that ssh polling is too costly (`0013:14`). `refresh.rs`
now polls every machine every 30 s over warm masters. Read free memory, load and power in that poll,
and freeze `yantra-agent` and placement until a scheduler is wanted.

**ADR-0015.** Supersede it once the store exists. Resume by stored session id, as T3 does
(`ClaudeAdapterV2.ts:1803-1804`), and drop both the fork and the newest-file lookup.

**ADR-0016 and ADR-0017.** Write one "who may call the daemon" ADR that replaces the rule spread
over 0016, 0017, 0038 decision 6 and four blockquotes. It must close the hole in
`crates/yantrad/src/write.rs:82-101`. Today `caller_address` trusts `X-Forwarded-For` whenever the
TCP peer is one of the daemon's own addresses. ADR-0017 accepted that because "a local process can
already do everything a write route can" (`0017:118-122`). That was true when the only local user
was the daemon's own. It is false now that agent sessions run on the hub under `karigar`. One option
needs a measurement on the box's Tailscale (1.104.4): `tailscale serve` to a Unix socket, with the
daemon checking the peer's uid. I did not test it. Close Y-143 in the same ADR.

**ADR-0018.** Keep the domain decision. Change how it is enforced:

- Every Yantra tmux call on a Mac uses a dedicated socket (`-L yantra`) and tmux's `-N` (do not
  start a server). ssh then cannot start a `Background` server. One place in `Tmux` kicks the
  LaunchAgent when no server answers.
- Add `ProcessType` `Interactive` to the plist. T3 sets it to avoid background throttling
  (`apps/server/src/cloud/bootService.ts:142-143`). I could not check launchd's man page, because
  the Mac did not answer ssh.

Two faults make this urgent. The Chat's keeper calls `tmux.ensure` without the gate
(`crates/yantra-core/src/keep.rs:286`). `login_server` returns true for any server that holds a
session (`crates/yantra-core/src/tmux.rs:366-369`), so it never checks the domain. ADR-0018 §5
claims the gate catches a leftover `Background` server. The code does not. A dedicated socket also
stops the owner's own `tmux kill-server` from ending Yantra's turns, and keeps the owner's sessions
out of the fleet (Y-645's "Kill" on sessions `0` and `1`).

**ADR-0021 and ADR-0023.** Keep the 0600 file. The daemon reads it and removes the secrets from its
own environment at start, before it starts any thread. That replaces the per-spawn rule. Apply a new
relay at once, with no restart, because a phone has no restart button. Then reopen OAuth App
against GitHub App. The token now pushes to and merges into every private repo. A GitHub App
installs per repo, and T3's refresh code is about 470 lines (`GitHubAppSignIn.ts`). Also weigh T3's
choice of reusing the host's `gh auth` (`GitHubCredentials.ts:47-76`).

**ADR-0024.** Withdraw §1's "every visible component lives in `m3/`" for surfaces copied from T3.
Bring in T3's `components/ui` primitives with MIT attribution. Map T3's token names onto
`--md-sys-color-*` in Tailwind's `@theme`. Copies then stay close to verbatim. Gate hover behind
`@media (hover: hover)`. Review the 200 KiB first-load budget against the Chat routes only:
research 15 rejected T3's markdown, list and diff code because of that budget (`15:163`, `:209`).
**No ADR decides the phone platform.** T3 answers "native" with an Expo app of about 95,000 lines.
Copying T3's web will not make the phone feel native by itself. Its web chat is desktop-first. An
ADR should choose: stay a PWA, tested in WebKit and on the real iPhone, or wrap it in a native
shell. My recommendation is to stay a PWA and test it properly first. A native app is 95,000 lines
the owner would maintain alone.

**ADR-0025.** Accept or reject it. A feature that shipped two months ago and is still "proposed" is
a loophole. Move the "seen" mark to the daemon so the phone and the laptop agree. Keep the ring in
the store from ADR-0004's replacement.

**ADR-0026.** Keep decisions 1, 3, 5, 6 and 7 and the isolate amendment. Decision 2 goes to
ADR-0041. Add Claude's session id to the store, or to the branch's git config as ACP already does
(`crates/yantra-core/src/thread.rs:12-13`). Widen the closed list of item types. Yantra has 4 item
types and 4 request types (`crates/yantra-core/src/chat.rs:181-186`, `:254-259`). It has no subagent,
background-task or user-input type, so decision 1 took T3's vocabulary in name only. Y-650, Y-654
and Y-658 need them. Y-653's premise is wrong: the Chat already renders sanitised GFM
(`web/src/screens/session/Chat.tsx:84-91`). What is missing is highlighting, copy and file links.

**ADR-0028, ADR-0029 and ADR-0030.** Y-628 (a non-sudo agent account) breaks their shared premise.
Split join into two halves. The admin account runs the root half once. Then the key goes to
`karigar`. Keep the user-local `claude` install. Retire the sudo terminal (0030) and show "run this as
your admin account" instead. Record Y-632's LaunchAgent in 0029.

**ADR-0031.** Supersede it through Y-651: speech becomes text in the browser or on the hub, into the
composer. Freeze the PipeWire path, and delete it when Y-651 ships.

**ADR-0032.** Freeze `history.rs` and `extract.rs`. Fix the title and CLAUDE.md §B1, which still
say "encrypted" (`CLAUDE.md:149`). The daily need is thread metadata, and the store answers it.

**ADR-0035 with ADR-0041.** Keep the keeper. It is the one thing Yantra does better than T3: a turn
survives a daemon update and a dropped link. T3 says "Restarting interrupts running agent turns"
(`docs/user/background-service.md:26`). Amend:

- **Decision 1.** Once a keeper outlives a turn, "the session exists" no longer means "a turn runs".
- **Decision 5.** The 64 MiB cap, and replacement at half of it, would kill a thread-long process.
- **Decision 8.** It re-reads the journal from byte 0 on each attach (`keep.rs:430`). A thread-long
  journal makes that up to 32 MiB over the tailnet at each phone reconnect.
- **Decision 9.** Adoption must rebuild the background-task roster.

**Was the per-turn keeper a reasonable call?** ADR-0026 decision 2 on 2026-09-07 was reasonable:
stream-json input was not yet verified. Re-affirming it on 2026-10-19 was a missed reading.
Research 20 verified stream-json input and then wrote: "A turn per process was enough, so that
upgrade is still not taken" (`20-claude-stream-json-turn.md:129-130`). It never tested what happens
after `result` when background work still runs. Research 15 recorded that T3 "drives one SDK session
per thread" (`15:68`). Research 21 read T3 at `72d5c32`, which already held the background-task
roster and the 4-hour idle pin. No Yantra note mentions Claude background tasks.

**ADR-0041 as proposed misses six things:**

1. **The pin.** T3 restarts the 4-hour pin on each provider event (`ProviderSessionManager.ts:1203-1206`).
   ADR-0041 counts from the last turn, so a build-loop run longer than 4 hours dies again.
2. **Replacement.** Its decision 6 replaces the keeper at half the cap, and `keep.sh:30-33` kills at
   the cap. Both end background work. Neither may run while tasks run.
3. **Live controls.** T3 changes model and mode on the live process (`ClaudeAdapterV2.ts:10767`,
   `:10792`). Without that, each Plan or Build toggle (Y-565) needs a new process and is refused while
   tasks run. The SDK on this host has `set_model`, `set_permission_mode` and `stop_task` strings. I
   did not test them against the CLI.
4. **Stopping a task.** "Stop background work" has no mechanism. T3 uses `stop_task`.
5. **A wake turn against a queued prompt.** Y-561 queues prompts. T3 has fixtures for this race.
6. **Session identity.** The newest-file resume stays at every keeper start.

Also: the ACP idle limit is 15 minutes (`crates/yantrad/src/chat.rs:128`), and the Claude limit would
be 30. ADR-0041 says the two keepers "share one life cycle". Delegated tasks still end with their
connection (`0035:281`), and no row covers that.

**ADR-0036, 0038 and 0039.** Freeze. Park M17 and Y-551 to Y-558 until M16 closes. Keep 0038
decision 6, the read gate, because it closes a real hole. If guests come back, copy T3's
`GuestShareService.ts`, a share link with a time limit for one thread.

**ADR-0040.** Split it. First the ADR-0017 fix above. Then park the agent grant until M16 closes.
The grant serves one marketing agent, not the daily loop.

---

## 3. Each practice

| Practice | Verdict | Reason |
| --- | --- | --- |
| §A1–§A5, think, simplify, surgical, goals, comments | Keep | No fault traces to them. §A4 is right, and the loop does not obey it (§1.3). |
| §A6, STE prose | Keep | It makes rows and replies short. The cost is volume, not style. |
| §B0, `tracker.md` is the source of truth | **Amend** | 263 KB, and its header is two months stale. |
| §B1, copy T3 | Keep, and enforce | ADR-0024 and the budget block it today. |
| §B2, orchestrate and keep four seams | Keep | Sound. The fault is what runs above the seams (§1). |
| §B3, podman realism | **Amend** | Podman is Linux with bash 5. It is not the Mac. |
| §B4, idempotency, no secrets, start small | Keep "start small" and enforce it | §2.2 is what ignoring it costs. |
| §B5, ADR amendments by blockquote | **Amend** | See ADR-0001. |
| §B5, summaries in the same PR | **Amend** | The rule fails on the most-read files. Cut the summaries rather than police them. |
| §B5, one PR per added row | **Drop** | 22 PRs since 2026-10-01 only added rows. Each ran CI and a merge. |
| Invariants in crate trackers | Keep | Best value per line in the docs. Add: an unverified item becomes a test or a row. |
| §B7, the loop merges unattended | **Amend** | Only with real-product proof for visible or machine rows. The same rule binds hand sessions. |
| §B7, priority rules | **Amend** | Six milestones are open, so "unblocks an open milestone" ranks nearly everything first. |
| §B7, model rules | Keep | No fault traces to the model. The reviewer's inputs are the problem. |
| Test strategy | **Amend** | Wide and shallow: three sizes, axe and layout sweeps, all against a fake with tidy data. |
| CI | **Amend** | The path filter is fine. Add WebKit, a fixture contract check and the real Mac. |
| Release cadence | **Amend** | Four releases in 29 hours; the walk moved on at every release. |

### 3.1 The documentation weight

An agent pays this before it changes any code:

| What it reads | Size |
| --- | --- |
| Root `CLAUDE.md` | 20 KB |
| `tracker.md` (by offsets; the whole file) | 263 KB |
| A `yantrad` row: `crates/yantrad/CLAUDE.md` + `tracker.md` + `llms.txt` + `README.md` | 85 + 12 + 48 + 18 = 163 KB |
| A `yantra-core` row: the same four files | 30 + 30 + 60 + 5 = 125 KB |
| A web row: `web/README.md` | 60 KB |

A `yantrad` row reads about 183 KB, or about 45,000 tokens, before it opens a source file. The build
loop measured about 50,000 tokens of start-up per agent (`build-rows.js:157`). The repo holds 3.6 MB
of Markdown against 3.4 MB of Rust. T3 has one 24 KB `AGENTS.md` for a far larger product. Its
rules say the opposite of ours:

- "Do not commit implementation plans, research notes, or agent scratch files."
- "A merged PR is the implementation record. … do not preserve a second checklist in the repository."
- "Do not document every feature, enumerate fields or methods, narrate control flow, maintain file
  catalogs, or append PR summaries."

I do not recommend copying all of that. The research notes and the invariants earn their place: they
hold what the code cannot say. But `crates/yantrad/CLAUDE.md` narrates every route in 85 KB, and each
crate's `llms.txt` is a file catalog. The summary rule (§B5) fails exactly there:

- `tracker.md`'s header says "Last updated 2026-09-03" and "Current milestone: none with buildable
  work open". Six milestones are 🟡 or planned.
- ADR-0032's title and `CLAUDE.md:149` say "encrypted" a month after the amendment dropped it.
- `build-rows.js:33` says CI runs every suite, five days after Y-607 changed that.

A summary that no check reads goes stale. **Cut the summaries; keep the links.**

### 3.2 The tracker and the priority rules

`tracker.md` is 263 KB. Its rows carry history, which the owner asked to stop on 2026-08-08. M6, M7,
M14, M15 and M16 are 🟡 wip and M17 is planned, so rule 1 ("closes or unblocks an open milestone")
fits nearly every row. The 2026-11-05 override ("a row that closes the daily-driver gap goes first")
is the right idea. It is prose that the triage agent interprets. Make it a list the triage reads:
rows outside the list are not eligible.

### 3.3 The build loop

The loop is not the only path to `main`. It merged 45 of the 97 PRs between 2026-11-03 and
2026-11-05. Hand sessions merged the rest under the same lack of proof, and they shipped the three
rows the loop parked. So a fix to the loop alone fixes half the problem. The rule must be in the
merge step that both paths use.

The loop's enforcement lives in prompt prose, and agents break prose: #568 used `;`, and #623 used a
pipe. The workflow script should run the merge guard and the merge itself. It should not ask an
agent to type the command.

### 3.4 The test strategy

Keep:

- the podman fixtures for ssh and tmux;
- the three sizes;
- axe;
- typed refusals.

Change:

- **Add a WebKit phone project.** The owner's phone is an iPhone, and every e2e run today uses Chromium.
- **Make the fixture daemon answer from real data.** Record the box's real `/api` answers once, with
  names redacted, and run a scenario from them. That is T3's "an empty database is a bad test". Long
  names, a 200-entry home directory and real refusal texts would have caught faults 8, 12, 23, 28
  and 30.
- **Check the fixture against the real daemon.** One test should run a few routes against both and
  compare the shapes and the timing class: immediate or eventual. Fault 25 is a fixture that agrees
  at once where the daemon lags.
- **Fix flakes; do not retry them.** Set Playwright `retries: 0`. Retire the loop's flake rule once the
  known flakes are fixed.
- **Add one cross-page count test.** Feed one fleet to every screen, and assert that each count agrees.
  This covers cause K (faults 16, 17, 26, 27).
- **Add a replay provider.** A recorded Claude stream through the real bridge, as T3's `Replay (dev)`
  does, would let the Chat run end to end in CI with no model and no fake of the bridge.

---

## 4. What to do next

Practice changes come first, because the practices are the main cause of escapes. Each row is a
proposal. The owner allocates the Y-number and decides each ADR. Rows 5, 7 and 8 need an ADR, so
the build loop may not take them alone.

1. **The build loop proves a visible row on the real product before it merges.**
   **Done when** the workflow script has a walk stage that runs the branch's `yantrad` and dashboard on a
   spare port against the real fleet, drives each changed screen in WebKit at 390 px and in Chromium
   at desktop, and attaches the screenshots to the PR. A reviewer reads them against the row's
   outcome, and the script's own merge step refuses a web or machine row without them. A test proves
   that a deliberately wrong copy change is caught.

2. **Run the real-machine tests.**
   **Done when** `manual_macbook.rs` has a Chat-turn test, and the loop's verify stage runs `just
   test-mac bishwajeets-macbook-pro` for any row that touches the chat, the keeper, tmux, the agent
   probe or a remote script. The same applies to the laptop, and every release runs both. Y-634's
   bash 3.2 bug, put back on a branch, fails the gate.

3. **A release waits for a recorded walk, by code.**
   **Done when** a release PR cannot merge without `docs/plans/walks/<version>.md`. That file records each
   smoke-pass check as pass or fail on the real box, Mac and iPhone. The pass gains a check for a Chat
   turn on the Mac and for a background task that finishes. Y-637's `walk.js` is built.

4. **Freeze breadth until the owner calls Yantra a daily driver.**
   **Done when** the triage prompt reads an allowlist from `tracker.md`: M16 (Y-495 to Y-499), Y-644,
   Y-645, Y-649 to Y-658, walk findings and defects. Every other open row is parked "until daily
   driver": M17, rooms, the microphone, placement and the ADR-0040 grant.

5. **ADR: the daemon keeps a small store of its own thread state.**
   **Done when** the owner accepts an ADR that supersedes ADR-0004's Y-044 amendment and ADR-0015 for the
   Chat. Then the Chat resumes by stored session id, and a podman test shows that a second `claude`
   run in the worktree does not change which conversation resumes.

6. **Amend ADR-0041 before it is accepted.**
   **Done when** Y-657's ADR covers the six gaps in §2.3: the pin restarts on activity, there is no
   replacement while tasks run, model and mode change live, a task can be stopped, a wake turn is
   ordered against a queued prompt, and the session id is stored. Y-658's done condition tests the
   pin with a task that runs longer than 4 hours of turns.

7. **The Chat survives a phone sleep.**
   **Done when** the chat socket pings in both directions and retries without a cap while the page is
   visible. It reconnects on `visibilitychange` and `online`, and resumes from its cursor. An e2e test
   holds the socket closed for 60 s mid-turn, and the turn then completes with no `closed` state.

8. **ADR: close the forwarded-header hole.**
   **Done when** the owner accepts an ADR that replaces ADR-0017's local trust. A test shows that a process
   on the hub, under another account, that sends a forged `X-Forwarded-For` gets a refusal. The phone
   through `tailscale serve` still writes. This goes before ADR-0040.

9. **The Mac's tmux gate is a lock, not a check.**
   **Done when** every Yantra tmux call on a Mac uses `-L yantra` and `-N`, the Chat keeper goes through
   the same path, and the plist sets `ProcessType` `Interactive`. A `test-mac` test shows that a Chat
   turn with no login server starts the LaunchAgent and runs. This needs an ADR-0018 amendment.

10. **Cut what an agent must read.**
    **Done when** each crate's `CLAUDE.md` is at most 15 KB, the crate `llms.txt` catalogs are gone, and
    `tracker.md` is under 80 KB, with closed rows archived and a current header. Rows are added in
    batches, not one PR each. A CI check fails when a `CLAUDE.md` grows past its cap.

**Not ranked, but cheap:**

- Gate hover behind `@media (hover: hover)` (`web/src/m3/tokens.css:604`).
- Scrub the secrets from the daemon's environment at start (ADR-0021).
- Accept or reject ADR-0025.
- Fix ADR-0032's title.
- Correct `build-rows.js:33` and `:35`.
- Retire ADR-0030's sudo terminal under Y-628.

**What I did not verify:**

- The launchd throttling behind `ProcessType`.
- The Unix-socket option for `tailscale serve`.
- The live control requests of the Claude CLI.
- The Chat's gate hole on a real Mac. I traced it from the code: the Mac did not answer ssh today.
- The cold start time of a Chat turn. No one has measured it.

## Sources

All accessed 2026-11-08.

- Yantra `main` at `6c7d7ea6`: `CLAUDE.md`, `tracker.md` (§0–§2 and rows Y-582 to Y-656), `llms.txt`,
  `docs/adr/0001` to `0039`, `crates/*/CLAUDE.md`, `crates/*/tracker.md`, `.claude/workflows/build-rows.js`,
  `.claude/workflows/merge-guard.sh`, `justfile`, `.github/workflows/ci.yml`, `web.yml`, `release.yml`,
  `web/playwright.config.ts`, `web/e2e/lib/sizes.ts`, `web/e2e/fixture/server.mjs`,
  `docs/plans/smoke-pass.md`, `docs/research/15`, `20` and `21`, and the source files cited inline.
- Open PRs [#643](https://github.com/2002Bishwajeet/yantra/pull/643) (ADR-0040) and
  [#646](https://github.com/2002Bishwajeet/yantra/pull/646) (ADR-0041, rows Y-657 to Y-659), read with
  `gh pr diff`.
- Merged PRs #400 to #642, listed with `gh pr list --state merged --search "merged:>=2026-10-01"`
  (241 PRs) and read with `gh pr view`.
- Build-loop reports `.claude/build-loop/2026-11-03.md`, `2026-11-04.md` and `2026-11-05.md` in the
  owner's checkout (not committed).
- T3 Code at `67eebaca`, local checkout `~/Github/t3code-ref`: `AGENTS.md`,
  `.agents/skills/test-t3-app/SKILL.md`, `.github/workflows/`, `docs/internals/connection-runtime.md`,
  `docs/user/background-service.md`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`,
  `apps/server/src/provider/ProviderSessionManager.ts`, `apps/server/src/persistence/`,
  `apps/server/src/auth/`, `apps/server/src/cloud/bootService.ts`,
  `packages/source-control-github/src/server/`, `apps/web/src/components/`, `apps/mobile/`.
- T3 Code at `b248f5a` and `72d5c32` (the commits research 15 and 21 read), fetched with `gh api`.
