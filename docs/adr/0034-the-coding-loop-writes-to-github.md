# ADR-0034 — The coding loop writes to GitHub

- **Date:** 2026-10-19
- **Status:** Accepted 2026-10-19 by the owner ([Y-487](../../tracker.md)), with no changes.
- **Evidence:** [the M16 plan](../plans/m16-the-coding-loop.md) §2 and §5, which reads T3 Code at
  `1451e7c`.
- **Amends** [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) (the grant now writes) and
  [ADR-0026](0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) (the Chat gets a diff panel).

## Context

The owner decided on 2026-10-19 that Yantra becomes the place where they do agent coding work: from
an issue, through review, to a merged PR. Yantra adapts T3 Code for that, and it does not compete
with T3 Code. The M16 plan lists the loop and its rows.

The loop writes to GitHub. It opens a PR, reads its checks and reviews, and merges it. ADR-0023 gave
the daemon a token with the scopes `repo read:org notifications` and left open "whether the scope
ever widens to write". GitHub documents `repo` as full read **and write** access to the owner's
repositories. So the daemon can already write. ADR-0023's exposure paragraph says a reader of
`daemon.env` can read the private repositories. That reader can also write them today.

The Chat has per-turn diffs as plain text (Y-448). ADR-0026 said Yantra ships no diff panel and no
`@pierre/diffs`. Review is the step the owner does most, and plain text is not enough for it.

## Decision

1. **The daemon's existing `repo` grant opens, reads and merges PRs.** No scope changes. The owner
   rules that the daemon uses the write access the token already has.
2. **Commits and pushes run on the machine** with the machine's git identity and credential. The
   token never crosses ssh. ADR-0023 decision 4 holds.
3. **Yantra stores no PR link.** It derives a thread's PR from its upstream branch through GitHub's
   `pulls?head=`. The PR watch keeps its state in memory and rebuilds it at start.
4. **The daemon reads an issue's title and body to start a thread, and never logs them** (Q5).
5. **`claude -p` on the machine writes the commit message**, with the machine's own login
   (ADR-0026 decision 7). The owner can edit it before the commit.
6. **The diff panel uses `@pierre/diffs` and `@pierre/trees`** (Apache-2.0), loaded in a lazy chunk.
   `THIRD_PARTY_NOTICES.md` carries their NOTICE text. Copied T3 files keep ADR-0026 decision 5's
   attribution.
7. **Yantra ships no editor.** Each file opens in the owner's editor through a
   `vscode://vscode-remote/ssh-remote+<machine><path>` link (or Cursor's or Zed's), because a machine
   name is an ssh destination (ADR-0009).

## Consequences

- Whoever reads `daemon.env` can push to and merge in the owner's repositories. That was already
  true, and now it is written down.
- Every new write route calls `allowed()` (ADR-0016) and adds its `yantra` verb in the same PR
  (ADR-0012).
- Auto-merge, PR stacks, other people's reviews and other git hosts stay out. The plan §3.11 says
  why. Y-355 (GitLab) stays open and unscheduled.
- `@pierre/diffs` is a 1.x package that T3 patches. If its chunk is too heavy on a phone, the
  fallback is Yantra's own `TurnDiff.tsx` with a file list.
- On acceptance, ADR-0023 and ADR-0026 each get a dated blockquote that points here (§B5).
