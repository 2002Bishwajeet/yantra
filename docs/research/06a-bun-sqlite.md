# R6a — `bun:sqlite` as Yantra's datastore

> ### ⚠️ Superseded runtime decision
> This note was written while the target runtime was **TypeScript on Bun**. That decision was
> superseded the same day by [ADR-0004](../adr/0004-rust-for-the-daemon.md) — the daemon is **Rust**.
> Kept unedited as dated evidence. Its findings about tmux, Tailscale, agent CLIs, prior art and
> scheduling remain valid; its **runtime recommendations do not**. Note that Bun was *not*
> disqualified — the verdict was GO-WITH-CAVEATS; the decision criteria changed, not the evidence.

**Researched:** 2026-07-28 · **Sub-note of** [06-runtime-feasibility.md](06-runtime-feasibility.md)
**Bun version in scope:** 1.3.14 (latest shipped, published 2026-05-13) · **main** where noted.

> Recovered note. This was produced by a sub-agent whose relay to its parent failed; captured here so
> the findings are not lost. Perishable — Bun moves fast, re-verify before relying on version claims.

## Summary

- **`bun:sqlite` is synchronous only.** No promise API in any release. Long queries block the event loop.
- **`busy_timeout` defaults to `0`** — unlike better-sqlite3's 5000 ms. Concurrent writers get `SQLITE_BUSY` *immediately*. **This is the finding most likely to bite Yantra in production.**
- **macOS bundles no SQLite at all** — Bun dlopens Apple's `/usr/lib/libsqlite3.dylib`, which reports **3.43.2** on macOS 15 arm64 despite the 1.3.14 blog claiming 3.53.0.
- **`node:sqlite` is in no shipped Bun release** — the PR merged 2026-07-17, two months after 1.3.14. `require("node:sqlite")` fails on Bun today.
- **Neither Drizzle nor Kysely has a clean `bun:sqlite` story.** Recommendation for Yantra v1: **no ORM.**

## API surface

Docs: `bun.com/docs/runtime/sqlite` (the `/docs/api/sqlite` URL 301s there).

```
new Database(f, { readonly, create, readwrite, safeIntegers, strict })
```

- `db.query()` returns a Statement **cached on the Database** (compiled bytecode, not results); `db.prepare()` is uncached.
- Statement: `.all/.get/.run/.values/.iterate/@@iterator/.raw/.as(Class)/.finalize/.toString`, plus `columnNames/paramsCount/columnTypes/declaredTypes`.
- **`.get()` returns `null`, not `undefined`.**
- `db.transaction(fn)` with `.deferred/.immediate/.exclusive`; nested → SAVEPOINT; `db.inTransaction`.
- `db.serialize(name?)` / `Database.deserialize()`, `db.loadExtension()`, `Database.setCustomSQLite()` (macOS only), `db.fileControl(op, arg)`.
- Multi-statement only via database-level `.run()` / `.exec()`.

**Absent:** `db.backup()` (not in docs, not in `sqlite.d.ts`), user-defined functions, aggregates,
`sqlite3_interrupt`, sessions/changesets, any `timeout` option.

## Bundled SQLite and the macOS problem

- Tag `bun-v1.3.14` bundles **3.53.0**; main has **3.53.2** (PR #32498).
- **macOS bundles nothing**: `scripts/build/config.ts:886` sets `staticSqlite = !darwin`, so both
  `bun:sqlite` and `node:sqlite` dlopen the system library.
- **Open issue #31247** (2026-05-23): `sqlite_version()` returns **3.43.2** on macOS 15 arm64 on 1.3.14
  *and* canary. That version carries the FTS5 `SQLITE_CORRUPT_VTAB` bug on UPDATE/DELETE. Reproduced by
  robobun. Fix PR #31249 **closed unmerged, labelled "ai slop"**. Duplicates #16717 (2025-01-24) and
  #24957 (2025-11-22) also open — **broken 18+ months**.
- On main, `process.versions.sqlite` deliberately reports the *bundled* version while the *loaded*
  library is Apple's. **It lies on macOS.**

Compile flags (`scripts/build/deps/sqlite.ts`): FTS3/FTS5/JSON1/RTREE/MATH_FUNCTIONS/COLUMN_METADATA/
UPDATE_DELETE_LIMIT, `MAX_VARIABLE_NUMBER=250000`. SESSION/PREUPDATE_HOOK/DBSTAT_VTAB/GEOPOLY/RBU
added **July 2026 only** — not in 1.3.14. `SQLITE_THREADSAFE` is never set by Bun → amalgamation
default = **1 (serialized)**.

## WAL

Works and is explicitly recommended: `db.run("PRAGMA journal_mode = WAL;")`.

macOS gotcha: `-wal`/`-shm` sidecars persist after close (Apple builds with persistent WAL). Workaround
is `db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0)` + `PRAGMA wal_checkpoint(TRUNCATE)`.

## busy_timeout — the ship-blocker

**Bun sets no default; it is 0.** A grep of `JSSQLStatement.cpp` (2949 lines) finds exactly one call —
line 285, `sqlite3_busy_timeout(db, 0)` — in the exit-time checkpoint path. There is no `timeout` in
`DatabaseOptions`. Request #5621 was closed 2023-09-18 as *wontfix* ("just run `pragma busy_timeout = 5000`").

**Yantra must set `PRAGMA busy_timeout` explicitly on every connection.** With five machines
heartbeating every 10 s against a daemon that also reads on the request path, the default of 0 produces
intermittent `SQLITE_BUSY` that will look like a network or agent fault.

## Concurrency / event loop

PR **#34863** (opened 2026-07-20, still open) quantifies it: a ~400 ms query against 100 concurrent
pings — `Database` serves **0/100**, ping p50 **419.93 ms**. The proposed `AsyncDatabase` serves 100/100
at p50 3.87 ms. Cost of async: 10k sequential reads 8.84 ms sync vs 179.66 ms async. Fixes #978, open
since **2022-08-04**.

**Implication for Yantra:** the daemon serves HTTP + WebSocket terminal streams off the same loop.
Every query must stay O(small). No analytics, no unbounded scans over session logs on the hot path.

## Open bugs worth knowing

| Issue | Date | What |
| --- | --- | --- |
| #34446 | 2026-07-17 | Concurrent `new Database(path)` **across Workers** intermittently sees empty schema / "no such table". Repro included. |
| #28911 | 2026-04-06 | Memory growth with dynamic query text OOMs a 1 GB container, even in-memory. |
| #33336 | 2026-07-04 | Windows long paths. |
| #28557 | 2026-03-25 | `bun test` panic with `mock.module()` + sqlite cycles, macOS. |
| #29494 | **closed** 2026-07-25 | `db.transaction()`'s internal statements were never finalized, so `close(true)` returned SQLITE_BUSY. Fixed by #27202 — **not in 1.3.14**. |
| #1474 / #31014 / #11397 | open | UDFs / `sqlite3_interrupt` / SQLCipher. |

BigInt truncation bugs (#5661/#5256/#1536) are all closed — `safeIntegers` is the answer.

## `node:sqlite` on Bun — not an escape hatch

PR #29821 was **closed unmerged**, superseded by **PR #32498, merged 2026-07-17**, which delivered full
`node:sqlite`: `DatabaseSync` (incl. `function()`, `aggregate()`, sessions/changesets), `StatementSync`,
module-level `backup() → Promise`, `process.versions.sqlite`, SQLite 3.53.2, and Node v26.3.0's vendored
suite (319 pass / 0 fail / 4 skip).

**It is in no shipped release.** Latest Bun is 1.3.14 (2026-05-13); the merge post-dates it by two
months. Proof: `src/resolve_builtins/HardcodedModule.rs` at tag `bun-v1.3.14` has **zero** occurrences
of "sqlite"; main registers `node:sqlite`. So `require("node:sqlite")` fails on Bun today — that is
drizzle issue #5515.

Node side, for reference: `node:sqlite` is **Stability 1.2 – Release candidate** on v26.5.0, v25.9.0 and
**v24.18.0 LTS**. No flag needed on any current line. On Bun, its `backup()` runs synchronously and
blocks the loop (Node uses a worker thread).

## ORMs

**Drizzle** — `drizzle-orm` 0.45.2 (2026-03-27), `drizzle-kit` 0.31.10 (2026-03-17); RC 1.0.0-rc.4 for
both (2026-06-27), and **the docs tell you to install `@rc`, so the documented path is not the `latest`
tag**. Runtime support is first-class (`drizzle-orm/bun-sqlite`, real subpath exports including
`./bun-sqlite/migrator`).

`drizzle-kit` is the weak spot: config is plain `dialect: 'sqlite'` + `dbCredentials.url`; there is **no
`driver: 'bun:sqlite'`** (valid drivers are aws-data-api and pglite only). Issue #1520 open since
**2023-11-16**. #4350 — maintainer said 2026-07-03 it is fixed **only in 1.0.0-rc4**. #5221 showed
`drizzle-kit migrate` picking `PgDialect` under Bun, and the maintainer confirmed drizzle-kit
**deliberately prefers libsql over bun:sqlite if `@libsql/client` is in your lockfile**.

Safe path if used: `drizzle-kit generate` + `migrate()` from `drizzle-orm/bun-sqlite/migrator`.
Do not confuse `drizzle-orm/bun-sql` — **PostgreSQL only** in 0.45.2.

**Kysely** — **no first-party `bun:sqlite` dialect.** The built-in sqlite dialect is better-sqlite3-shaped
(needs `statement.reader`, array params); bun:sqlite is not drop-in. Issue #705 closed 2025-03-04 with no
dialect; #1292 still open. Community dialects are mostly stale: `kysely-bun-sqlite` 0.4.0 (2025-05-12,
peer `kysely ^0.28.2` — excludes current kysely), forks likewise. **`kysely-bun-worker` 2.0.1
(2026-07-21, peer `kysely >=0.29`) is the only maintained one**, and it runs bun:sqlite in a Worker —
which collides with open bug #34446.

## Recommendation for Yantra

1. **No ORM in v1.** Both options have Bun-specific sharp edges, and Yantra's schema is a handful of
   tables (machines, workspaces, sessions, placement records). Raw `bun:sqlite` with hand-written SQL is
   less code and fewer unknowns. Revisit only if the schema stops being trivial.
2. **Set `PRAGMA busy_timeout` and `PRAGMA journal_mode = WAL` on every connection open.** Non-negotiable.
3. **Keep every query O(small).** The daemon shares its loop with WebSocket terminal streams.
4. **Use `safeIntegers`** to avoid the BigInt truncation class entirely.
5. **Do not use Workers with SQLite** until #34446 closes — which also rules out `kysely-bun-worker`.
6. **Write your own backup** as `VACUUM INTO` — `db.backup()` does not exist.
7. **If the daemon ever runs on macOS**, expect SQLite 3.43.2 and avoid FTS5. On the Linux appliance
   this is a non-issue.

## Sources

Accessed 2026-07-28. Bun docs `bun.com/docs/runtime/sqlite`; Bun repo tags `bun-v1.3.14` and main
(`scripts/build/config.ts`, `scripts/build/deps/sqlite.ts`, `src/bun.js/bindings/JSSQLStatement.cpp`,
`src/resolve_builtins/HardcodedModule.rs`); Bun issues #31247, #16717, #24957, #34863, #978, #34446,
#28911, #33336, #28557, #29494, #5621, #1474, #31014, #11397; Bun PRs #29821, #32498, #31249, #27202;
Drizzle issues #1520, #4350, #5221, #5515; Kysely issues #705, #1292; npm registry for version/date data;
`nodejs.org/docs/<ver>/api/sqlite.json` for per-version stability.
