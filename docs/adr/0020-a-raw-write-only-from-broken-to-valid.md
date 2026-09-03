# ADR-0020 — A raw write moves a workspace file from broken to valid, and nowhere else

- **Date:** 2026-08-22
- **Status:** accepted (2026-08-11, by the owner — the scope below is theirs, and
  [D3](../design/03-dashboard-surface.md) §12.1 states it)
- **Closes:** the last clause of [Y-190](../../tracker.md#3-task-board), which was blocked on this
- **Builds on:** Y-137, which made a file get the same refusals a request gets, and Y-141, which made
  a file that does not load cost only itself. Authorisation is
  [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)'s and is unchanged.

## Context

`brainstorm.md`'s UI Philosophy asks that nobody write a workspace file by hand — *the interface
should generate them automatically*. Every verb honours that. One case does not, and it is the case
where the interface is most needed.

**A workspace file that will not load cannot be repaired by any verb Yantra has.** `workspace::update`
loads the file before it writes it, so `yantra edit` and `PATCH /api/workspaces/{name}` both fail on
the file they are being asked to fix. Y-137 found this and wrote it down rather than working around
it:

> `update_in` loads before it writes, so neither `yantra edit` nor `PATCH` can repair a blank field;
> the file is the fix, exactly as it is for a mistyped key.

That is right, and it is not a defect in `update`. Loading first is what lets an edit name one field
and leave the other two alone, and a `PATCH` that wrote `machine` over a file it never read would
compose a workspace out of one field and whatever the caller happened not to send.

Three faults reach this state, and none of them is exotic: TOML that does not parse, a mistyped key
(`deny_unknown_fields`, ADR-0007), and a required field left blank. Every one is a file an operator
edited by hand or a `git` merge left half-written.

**So the dashboard names the error and offers nothing** (D3 §7.5). What it offers instead is a
terminal, and from a phone a terminal is worth nothing — which is the sentence
[ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md) was written to stop
being true. This is the founding UI principle broken in exactly one place, and closing it means
letting the daemon write bytes it did not compose.

That is the thing worth an ADR. Every other write in this system is Yantra rendering a `Workspace`
it has already checked; `render` is three keys and the operator never sees a parser. A route that
takes bytes is a route where the schema stops being enforced by construction.

## Decision

The owner decided the scope on 2026-08-11, so this records it rather than exploring it:

> The daemon may write bytes to a workspace file it did not compose **only when the file currently on
> disk does not parse, and only when the bytes it is given do**. Every other raw write is refused.

**The two bounds are one property.** Together they mean the raw path can move a file from *broken* to
*valid* and nowhere else. It cannot create a broken file, it cannot touch a good one, and it cannot
bypass the refusals Y-137 put on both sides of `create` and `update` — because it asks `parse`, which
is the same predicate `load` asks.

1. **A file that loads is refused.** `workspace::Error::Loads`, a **409** on the route. A workspace
   that works is changed field by field, where every field is checked and the other two are left
   alone. A second way to write one whole is how a good file becomes a bad one.

2. **Bytes that will not load are refused, naming the next error.** `parse` runs before anything is
   written, and its refusal is the answer — a **400**, carrying the whole `source()` chain. Naming
   the *next* error rather than a summary is the load-bearing half: the caller is answering the error
   it was shown, and a refusal that said only *that did not work* would send it back to the same
   screen with nothing new.

**The refusals are the tests**, which is this crate's own convention. `workspace.rs` proves all
three against a real filesystem in a temporary directory — a raw write over a file that loads leaves
that file byte for byte as it was, a raw write of bytes that still will not load names the field that
is still wrong and writes nothing, and a raw write of bytes that parse replaces a file that does not
and empties the listing's `unusable`.

**The read is bounded the same way and by the same call.** `workspace::broken` answers
`Error::Loads` for a file that parses, so a caller cannot be shown a file it may not send back, and
`repair` asks `broken` rather than repeating the question. One predicate, both halves — Y-137's own
shape.

**It is authorised as a write, and so is the read beside it** (ADR-0016). `GET
/api/workspaces/{name}/repair` lives in `write.rs` rather than `api.rs` for two reasons: a file's raw
bytes are the one thing `GET /api/workspaces` does not publish, and the page that asks for them
already needs the gate for the `POST`. This is ADR-0019's consequence pointed the other way — there,
classifying a read as a write made it safer; here, the read simply keeps the write's gate.

### The CLI-first rule, which this decides rather than reads

`crates/yantrad/CLAUDE.md`: *anything the web UI can do must be expressible in `yantra` first.*
D3 §12.1 argued the CLI is not missing this — on the machine holding the file, repairing it is
`$EDITOR ~/.config/yantra/workspaces/x.toml` — and said outright that this was a reading rather than
a ruling.

**It is ruled the other way, and `yantra repair <workspace>` ships**, reading the file from stdin.

The argument that the CLI is already covered is exactly the argument that erodes the rule, and it
happens to be wrong on the merits here. `$EDITOR` writes the file and says nothing about whether the
repair worked; the operator finds out at the next `yantra ls workspaces`. What the daemon gains is
not *a way to write the file* — the filesystem was always that — it is **the two refusals**, and a
CLI that does not have them is a CLI where the terminal is the second-class client. So:

```
yantra repair site < fixed.toml
```

inherits both bounds unchanged, and exits 1 with the next error on stderr when the bytes still will
not load.

**The read half stays `cat`.** Every refusal already prints the file's path, and `yantra ls
workspaces` prints it under the table for the file that did not load, so a verb that only echoed
those bytes would buy nothing.

**It is `repair` and not `put`, which is where this departs from D3 §12.1's wording.** That section
named `yantra put <workspace>` as the smallest verb that matches. One act should have one name
across the CLI, the route and the page (§A6, *one word, one meaning*), and *repair* is the name the
page already has. It is also the truer one: `put` describes a mechanism and promises a write, while
the two refusals are what make this a repair and are free to say no.

## Consequences

**You cannot save a partial fix and come back to it.** This is the real cost and D3 §7.5 names it
first: on a phone, half-way through a file with two errors, the save is refused and what is on screen
is all that stands between you and losing the work. It is the price of the daemon never holding a
write that skips `workspace::parse`.

**A draft is available and is deliberately not built.** `update` already writes through
`<name>.toml.tmp`, and `list` ignores anything that is not `.toml`, so a half-finished repair *could*
be parked there. It is refused because a draft nothing else can see is a repair the system forgets:
`GET /api/workspaces` would keep reporting the broken file, a second device would open the file
rather than the draft, and the daemon would be holding a half-finished thing it holds nowhere else
(Y-044). If the phone case turns out to hurt, this is the shape to reconsider, and it is a new
decision rather than a loosening of this one.

**Two workspace verbs can now write the same file, and they do not check each other.** Nothing locks
`~/.config/yantra/workspaces/<name>.toml`, so a repair and an edit issued at the same moment resolve
by whoever renames last, exactly as two `PATCH`es already do. The rename keeps each write whole, so
the loser is overwritten rather than interleaved. Unchanged by this ADR and worth saying out loud,
because a raw write is the first one that carries a whole file rather than three fields.

**The daemon serves a file's bytes for the first time.** A workspace file holds no secret by
construction — ADR-0007 gives the schema nowhere to put one, and §B4 makes `startup` a reference the
far shell resolves — so this publishes no class of value that `GET /api/workspaces` did not already
publish as `startup`. What is new is that it publishes them *unparsed*, including whatever a
half-finished edit left in the file, which is why it sits on the write authoriser.

**A workspace still cannot be created this way.** A file that is not there is `NotFound`, never an
empty file to fill in. `create` refuses to overwrite and this refuses to invent, so the two verbs
cannot be composed into one that does both.

**`update`'s load-first behaviour is now load-bearing rather than incidental.** It was a consequence
nobody chose; after this it is the reason the raw path exists and may not be relaxed to close the
same hole a second way.

### Not decided here

- **Whether any other file may be written raw.** Nothing else in Yantra is a file the operator edits,
  and the ntfy relay's settings — D3 §12.2, the other undecided write — are a value that must survive
  a restart rather than a file that will not parse. A second raw write is a second decision.
- **`list`'s all-or-nothing rule and its per-file replacement.** Y-141 settled those and this
  changes neither.
- **What happens to a `.toml` whose *name* is unusable.** `InvalidName` is refused before any
  filesystem call (I-57) and stays that way: a file called `my.app.toml` is not repairable through
  this route, because the fix is `mv` and there is no workspace name to address it by.
