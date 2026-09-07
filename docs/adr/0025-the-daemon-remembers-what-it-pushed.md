# ADR-0025 — The daemon remembers the last events it pushed

- **Date:** 2026-09-06
- **Status:** proposed (Y-343). Built in memory behind the notifications board the owner drew;
  the owner accepts or rejects it when the board is reviewed.
- **Amends** the doc comment on `Attention.notifications` in `crates/yantrad/src/api.rs`, which
  says a count and never a list, and Y-044's *the daemon persists nothing*, by exactly nothing on
  disk.

## Context

The notifications boards (`NotificationsPopover`, `TabletNotifications`, `PhoneNotifications`)
draw a list: a session waiting for trust, a review requested, a crash with its exit code, a
finished session, a machine that became unreachable, and the relay's test message, each with an
age, an Unread/All filter and Mark all read.

Today the daemon has all of these as moments and none of them as a list. `notify::Watch` diffs
two agent readings, sends each verdict to the ntfy relay, and drops it; a failed send drops it
too, by rule. `GET /api/attention` carries GitHub notifications as a count because the titles
would land in a journal.

## Decision

**`Fleet` keeps a ring buffer of the last 50 events the daemon would push, in memory, and serves
it at `GET /api/notifications` as `Answer<Vec<Event>>`.**

1. An `Event` is `{ at, kind, workspace | machine, said }`, where `kind` is one of the
   `Verdict`s the relay already sends, `unreachable` for a machine whose `online` flipped, and
   `relay-test`. GitHub items are **not** events; they stay in `/api/attention` and the browser
   merges the two lists. Titles from GitHub still do not land in the daemon's journal.
2. The buffer is filled by the same code path that sends to the relay, before the send, so a
   dropped send is still a remembered event.
3. Nothing is written to disk. A restart empties the list, and the page says so: the first look
   after a start shows nothing, which is I-59 stated rather than hidden.
4. Read and unread are the browser's: one `localStorage` key holding the newest `at` the owner
   has seen. Mark all read moves it. The daemon has no read state.
5. The CLI verb is `yantra ls notifications`, first.

## Consequences

- State about the past now lives in the daemon, in memory, bounded at 50. Y-044's audit was about
  a store; this is a `VecDeque` beside `Beats`, which is already state about the past.
- The bell's badge is the count of events newer than the browser's mark, plus GitHub's count.
- A machine's `online` flip needs one new diff in `refresh.rs`'s machine sweep; the relay does
  not push it today and this ADR does not add that push.

### Not decided here

- Whether the buffer should survive a restart. If the owner wants it, that is a file and an ADR.
- Whether GitHub notifications should ever be listed by title.
