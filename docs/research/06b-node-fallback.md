# R6b — Node.js as the fallback runtime: what it would actually cost

> ### ⚠️ Superseded runtime decision
> This note was written while the target runtime was **TypeScript on Bun**. That decision was
> superseded the same day by [ADR-0004](../adr/0004-rust-for-the-daemon.md) — the daemon is **Rust**.
> Kept unedited as dated evidence. Its findings about tmux, Tailscale, agent CLIs, prior art and
> scheduling remain valid; its **runtime recommendations do not**. Note that Bun was *not*
> disqualified — the verdict was GO-WITH-CAVEATS; the decision criteria changed, not the evidence.

**Researched:** 2026-07-28 · **Sub-note of** [06-runtime-feasibility.md](06-runtime-feasibility.md)

> Recovered note. Produced by a sub-agent whose relay to its parent failed; captured here so the
> findings are not lost. Findings marked **[V]** were verified empirically — the agent downloaded and
> ran Node v26.5.0 and Bun 1.3.14 on linux-x64. Perishable; re-verify version claims.

## Summary

- **Node 24 "Krypton" LTS is the fallback**, not Node 22 or 20. Node 20 and 25 are already EOL.
- **TypeScript and SQLite are non-issues on Node.** Type stripping is `Stability: 2 - Stable`, on by default and unflagged since 23.6.0/22.18.0. `node:sqlite` is RC and needs no flag.
- **The two things Node cannot give us are exactly the two things Yantra needs**: `bun build --compile` **cross-compiles**; Node SEA **cannot**. And `bun:ffi` has no comfortable Node answer — which matters because ADR-0003 plans a Rust helper.
- **Bun's project-health signals are worth watching**: 4,087 open issues vs Node's 796, an open JSC GC leak issue, and no release in 2.5 months against a normal 1–3 week cadence.
- Switching to Node costs four dependencies (`ws`, `execa`, `esbuild`, `@node-rs/argon2`) and drops one (`dotenv`).

## Release lines (verified against `nodejs.org/dist/index.json` + `nodejs/Release/schedule.json`)

| Line | Latest | Status | EOL |
| --- | --- | --- | --- |
| v26 | v26.5.0 (2026-07-08) | Current → LTS 2026-10-28 | 2029-04-30 |
| **v24 "Krypton"** | **v24.18.0** (2026-06-23) | **Active LTS** | **2028-04-30** |
| v22 "Jod" | v22.23.1 | Maintenance LTS | 2027-04-30 |
| v25 | v25.9.0 | **DEAD** | 2026-06-01 (past) |
| v20 "Iron" | v20.20.2 | **DEAD** | 2026-04-30 (past) |

## TypeScript on Node — a non-issue **[V]**

`doc/api/typescript.md` reads `Stability: 2 - Stable` at both v24.18.0 and v26.5.0. Timeline:
`--experimental-strip-types` in v22.6.0 → **default in v23.6.0/v22.18.0** → warning removed
v24.3.0 → **stable, flag renamed `--no-strip-types`, in v25.2.0/v24.12.0** → `--experimental-transform-types`
**removed in v26.0.0** (hard removal; the process refuses to start).

Verified: `node t.ts` runs with no flag and no warning; **there is no type checking** —
`const x: number = "definitely a string"` ran and printed the string.

Strip-only limitations that shape our source style: no `enum`, no parameter properties, no `namespace`
with runtime code, no import aliases, no decorators, no `.tsx`; **`tsconfig.json` is ignored entirely**
(no `paths`, no downleveling); file extensions mandatory (`import './file.ts'`); `import { SomeType }`
without `type` is a runtime error; TypeScript inside `node_modules` is refused; source maps are neither
emitted nor needed.

**Actionable now, regardless of runtime:** set `erasableSyntaxOnly: true` and `verbatimModuleSyntax: true`
in tsconfig. That is the guard rail that keeps Yantra's source portable between Bun and Node, and it
costs nothing to adopt on day one.

## `node:sqlite` — RC, and it cross-validates R6a **[V]**

`Stability: 1.2 - Release candidate`. Unflagged since v23.4.0/v22.13.0; promoted to RC in v24.15.0.
Bundled SQLite: 3.53.3 on v26.5.0, 3.53.1 on v24.18.0.

Has WAL, prepared statements, `backup()` (async, returns a Promise — the one async API), `loadExtension`,
sessions/changesets, `aggregate()`, `function()`, `setAuthorizer()`. All things `bun:sqlite` lacks.

**Cross-validates R6a's ship-blocker:** `node:sqlite`'s `timeout` option **also defaults to 0**. The
busy-timeout trap is not Bun-specific — invariant I-12 holds on either runtime.

**But the two are mutually incompatible [V]:** under Bun 1.3.14, `require("node:sqlite")` throws
`ERR_UNKNOWN_BUILTIN_MODULE`; Node has no `bun:sqlite`. Either abstract behind an adapter or use
`better-sqlite3`, which works on both. This is a concrete argument for keeping the datastore behind a
narrow interface per ADR-0003.

## Packaging: the decisive difference

`--build-sea` landed in **v25.5.0** — the postject dance is gone, verified end-to-end in one command.
ESM is now supported (`"mainFormat": "module"`), contradicting the widespread "CommonJS only" belief.
**Both are absent from v24.18.0's docs**, so the LTS line still documents the old, worse flow.

Measured on linux-x64, hello-world, 20-run averages:

| | Binary size | Startup |
| --- | --- | --- |
| `node --build-sea` (v26.5.0) | 141 MiB | 27 ms |
| `bun build --compile` (1.3.14) | **90 MiB** | **11 ms** |
| bare `node -e ''` | — | 22 ms |
| bare `bun -e ''` | — | **1 ms** |
| `node app.ts` | — | 70 ms (Amaro/SWC WASM load) |
| `bun app.ts` | — | 12 ms |

**Node SEA cannot cross-compile.** For an appliance built on a workstation and shipped to Pi 5 arm64 —
plus macOS and Windows clients — that is close to disqualifying on its own. `bun --compile` also gives
`--bytecode`, automatic bundling of `.node` addons and assets, and Windows binary metadata.

Bun's own docs concede: *"Bun's binary is still way too big and we need to make it smaller."*

## What switching to Node would cost

**Genuinely lost:** `Bun.serve({ websocket })` — Node has **nothing** built in (its global `WebSocket`
is **client-only**), so add `ws`. `Bun.$` — no `node:shell` exists, add `execa`/`zx`. `Bun.build()` →
esbuild. `bun --hot` (preserves `globalThis`, keeps the server bound) vs `node --watch` which restarts
the process. `Bun.password` → `@node-rs/argon2`. **`bun:ffi` — the biggest ergonomic loss**; Node's
answer is writing a C addon, closest third-party is `koffi`.

**Not lost:** `--env-file` is stable since v24.10.0 (drop `dotenv`), `node --watch`, `node --run`,
`Bun.spawn` → `child_process`, `Bun.file/write` → `fs/promises`. **`node:http` works under Bun [V]**,
so an HTTP layer written against it is portable in one direction.

**Performance is not the argument.** The agent flagged 2026 benchmark articles as SEO slop with wildly
inconsistent figures (183k vs 65k req/s; "3x"; "4x"). The one production-shaped measurement it trusted:
**12,400 vs 12,000 req/s — under 3%.** Irrelevant for a personal daemon. What is actually lost is
ergonomics, not throughput.

## Bun project-health signals

Not disqualifying, but worth tracking for something meant to run 24/7 for years:

- **4,087 open issues** on oven-sh/bun vs **796** on nodejs/node (not like-for-like, but the gap is real).
- Open long-running leak issues, notably **#29267 (2026-04-13, "JSC GC fails to reclaim")**, plus
  #25550, #24858, #20912, #19254.
- **Last release 1.3.14 on 2026-05-13 — 2.5 months ago**, against a normal 1–3 week cadence.

**Explicit misinformation warning from the agent:** several 2026 articles (theregister.com, devclass.com,
lavx.hu, tech-insider.org, buildmvpfast.com) attribute April-2026 events to **Bun 1.1.13, which shipped
mid-2024**, and push an implausible "Anthropic bakes memory fixes into Bun" framing plus a "Bun Rust
rewrite" claim. **These do not check out. Do not cite them.**

## `node:test` — stable module, experimental good parts

Module is `2 - Stable`, and snapshot testing has been non-experimental since v23.4.0. But **coverage is
still `1 - Experimental`** (`--experimental-test-coverage`, and `--test-coverage-lines` is explicitly
experimental), and **`mock.module()` is `1.0 - Early development`** behind
`--experimental-test-module-mocks`.

Under Bun, `node:test` is an incomplete shim **[V]**: `bun test` failed on a file using
`t.assert.snapshot()`; `bun:test` is jest-shaped (`toMatchSnapshot()`). **Tests are not portable
between the runtimes** — pick one test API and accept it is a rewrite if the runtime changes.

## Recommendation

**Stay on Bun**, and the reason is narrow and specific: **cross-compilation to arm64** and **`bun:ffi`**
for the planned Rust helper. Those are Yantra-shaped needs, not general preferences — on every other
axis Node 24 LTS would be a fine, arguably safer choice.

Make the fallback cheap rather than hypothetical:

1. Set `erasableSyntaxOnly: true` + `verbatimModuleSyntax: true` in tsconfig **from the first commit**.
2. Keep the datastore behind a narrow interface (`bun:sqlite` and `node:sqlite` are mutually exclusive).
3. Write the HTTP layer against `node:http` semantics, or use Hono, which runs on both.
4. Accept that the test suite is **not** portable, and do not pretend otherwise.

If ADR-0003's trigger T1 fires, the target is **Node 24 LTS** — and the bill is four dependencies plus
the loss of cross-compilation, which likely means building on the Pi itself.

## Sources

Accessed 2026-07-28. `nodejs.org/dist/index.json`; `nodejs/Release/schedule.json`; Node doc markdown at
git tags `v26.5.0` and `v24.18.0` (`typescript.md`, `test.md`, `sqlite.md`,
`single-executable-applications.md`, `cli.md`, `documentation.md`); Node PRs #54283, #56350, #58643,
#60600, #61803, #55890, #61262, #55897, #56298, #59925, #61167, #51594, #53352, #52074, #53619;
bun.com docs (executables, http, shell, hot, install); `github.com/oven-sh/bun/issues/29267`;
byteiota.com benchmark analysis; npm registry dist-tags. Empirical runs on linux-x64.
