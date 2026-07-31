# yantra — tracker

The slice of [`tracker.md`](../../tracker.md) that belongs to this crate: **the invariants that bind
code in `crates/yantra`**, and nothing else. The main tracker still owns milestones, tasks,
decisions, open questions and risks, and it still wins when anything disagrees with it.

**This crate has no invariants of its own, and that is the finding.** Everything research proved
the hard way was proved about somebody else's program — ssh, tmux, tailscale, claude — and all of it
lives in [`yantra-core`](../yantra-core/tracker.md) because that is the crate allowed to talk to them.

What binds this crate instead is a contract it wrote itself: **the exit codes**, in
[`CLAUDE.md`](CLAUDE.md). Nothing external forces those values, which is exactly why they are easy to
change by accident and why they are written down.

One invariant reaches here from the other side. [I-30](../yantra-core/tracker.md) — `kill-session`
has three spellings for "already absent" — is what makes `yantra down` on a session that is not
running exit **0**: absence is the state that was asked for. The rule is core's; the visible
behaviour is this crate's.

## Open work

Task rows live in [`tracker.md` §3](../../tracker.md). Open and touching this crate: **Y-066** (name
the trust-prompt state).
