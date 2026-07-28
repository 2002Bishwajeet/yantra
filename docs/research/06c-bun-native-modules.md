# R6c — Bun native modules (N-API), release cadence, and the Pi 5 page-size landmine

> ### ⚠️ Superseded runtime decision
> This note was written while the target runtime was **TypeScript on Bun**. That decision was
> superseded the same day by [ADR-0004](../adr/0004-rust-for-the-daemon.md) — the daemon is **Rust**.
> Kept unedited as dated evidence. Its findings about tmux, Tailscale, agent CLIs, prior art and
> scheduling remain valid; its **runtime recommendations do not**. Note that Bun was *not*
> disqualified — the verdict was GO-WITH-CAVEATS; the decision criteria changed, not the evidence.

**Researched:** 2026-07-28 · **Sub-note of** [06-runtime-feasibility.md](06-runtime-feasibility.md)

> Recovered note. Produced by a sub-agent whose relay to its parent failed. Method: `curl` against the
> npm registry, authenticated `gh api` (releases/issues/code search), raw source reads comparing tag
> `bun-v1.3.14` against `main`, and WebFetch of bun.com docs/blog. Highly perishable.

## Summary — the five things that matter to Yantra

1. **🔴 Bun does not run at all on 16k/64k-page aarch64 kernels — and the Raspberry Pi 5 defaults to 16k pages.** Open tracking issue #17627. This is the single most important finding in the entire research round.
2. **Bun stable is frozen.** No release in **76 days** (1.3.14, 2026-05-13) against a prior 10–21 day cadence, because Bun is being **rewritten in Rust** (PR #30412, ~1M lines, merged 2026-05-14; v1.4.0 in canary, **no ship date**).
3. **On stable, `napi_get_version()` returns 9 while `process.versions.napi` reports `"10"`.** Feature-detecting addons silently take degraded paths. Fixed only on unreleased main (#34146).
4. **`better-sqlite3` is deliberately blocklisted** inside `process.dlopen`, which breaks `prebuild-install` into a doomed `node-gyp` fallback.
5. **Yantra is almost entirely immune to items 3–4**, because its design uses *zero* native addons. See "Why this mostly doesn't hit us".

## 🔴 The Pi 5 page-size landmine

**Issue #17627** — "support non-4k page sizes on aarch64 linux". **OPEN**, created 2025-02-24, updated
2026-04-10. Bun does not work on 16k or 64k page-size kernels. Affected: **Raspberry Pi 5** (16k
default, *revertable*), **Asahi Linux** (16k, unchangeable), **Ampere** on 64k kernels.

Progress: the Zig runtime-page-size upgrade landed (#17820), but 16k/64k manual verification, the
WebKit `PageBlock.h` option, and CI coverage for both remain **unchecked**.

**This breaks the Bun binary before any of Yantra's code runs.** It is not a native-module problem, not
a performance problem — the runtime does not start.

**Mitigation:** the Pi 5's 16k page size is a kernel choice and can be reverted to a 4k kernel via
`config.txt`. That makes this survivable, but it becomes a **hard, documented provisioning requirement**
for the appliance, and it must be verified on real hardware before ADR-0003 is considered settled.

Related, and separately worrying: **#23685** (OPEN, 2025-10-15) — node-gyp platform detection emits
`darwin-unknown-arm64` instead of `darwin-arm64`. Reported on macOS, but it is exactly the class of bug
that would corrupt `linux-arm64` lookup paths. Test, don't trust.

**Negative finding, stated carefully:** the agent searched hard and could **not** substantiate any
linux-arm64-specific node-gyp/prebuild breakage — no open issues against `node-gyp-build`, `prebuildify`,
or `@napi-rs/*` prebuilts on linux-arm64. But absence of reports may reflect low arm64 usage rather than
correctness. **Record as "unverified", never as "works".**

## Bun is mid-rewrite

| Fact | Value |
| --- | --- |
| npm `latest` | **1.3.14**, published 2026-05-13 |
| npm `canary` | 1.3.13-canary.20260425.1 — **stale 3 months** |
| `main` version | **1.4.0** |
| Gap since last stable | **76 days** (prior cadence: 10–21 days) |

Cause: **PR #30412 "Rewrite Bun in Rust"**, merged **2026-05-14** — ~1,009,257 lines added across 2,188
files, 6,755 commits. Bun was acquired by Anthropic in December 2025. Official blog
`bun.com/blog/bun-in-rust` (2026-07-08): *"Bun v1.4.0 will be the first version of Bun written in Rust.
It's available in canary now"* — **no ship date**, and **nothing whatsoever about N-API/native-addon
compatibility under the rewrite**.

Corroborated by contributor `sroussey` on #4290 (2026-07-15): *"Merged so there can't be a 1.3.15 bug
fix release, but it has not been released. 1.3.14 is the current version, based on zig."*

Main is visibly Rust now: `src/runtime/napi/napi_body.rs`, `src/install/PackageManager.rs`,
`src/bun_core/Global.rs`. C++/JSC bindings remain at `src/jsc/bindings/`.

**Consequence: roughly 25 N-API fixes merged in July 2026 alone are unreleased.** Anyone on stable is on
a two-month-old snapshot with a known-frozen fix pipeline.

> **⚠️ Conflicts with [R6b](06b-node-fallback.md).** R6b flagged 2026 press claims of a "Bun Rust
> rewrite" as not checking out. R6c has primary evidence — the merged PR and Bun's own blog — that the
> rewrite is **real**. Reconciliation: the *rewrite* is real; the *secondary articles* were still wrong,
> attributing April-2026 events to Bun 1.1.13 (mid-2024). Trust the primary sources; R6b's warning
> against citing those outlets stands.

## "Closed" does not mean fixed

The agent spot-checked recently-closed issues and found they were closed by the **bot account
`robobun`**, which closed **1,148 issues in the 8 days 2026-07-20 → 2026-07-28**, against 4,087 still
open — mass-closing 2023/2024-era issues as `completed`.

robobun's own closing comment on #35301 (2026-07-23): *"…it turns out this is **already fixed on main
(the fix landed after 1.3.14 and is not in a stable release yet)**."*

**"Closed" here means "fixed on unreleased main."** Do not read closed-issue counts as user-visible
fixes — and treat R6b's raw 4,087-vs-796 open-issue comparison with the same caution.

## N-API state, briefly

- **Version mismatch on stable:** `process.versions.napi` is hardcoded `"10"` (`BunProcess.cpp:254`),
  while `napi.zig:925` returns `9`. Fixed only on main by #34146 (2026-07-14).
- **`nan` / V8 C++ addons remain unsupported after ~3 years.** #4290: OPEN since 2023-08-24, 89 comments,
  273 reactions, no recent maintainer reply. The V8 shim is real but lacks Array, ArrayBuffer, non-trivial
  FunctionTemplate/ObjectTemplate, and env cleanup hooks.
- **`node-addon-api` works** — it is a header wrapper over N-API, not V8. **Do not conflate the two.**
- **libuv polyfills are ~14% complete** (#18546: 3 of ~22 functions). Blocks dd-trace runtime metrics,
  Sentry/Datadog profiling, odbc, zeromq, ffi-napi. `process.versions.uv` is a **hardcoded lie** on POSIX.
- **`better-sqlite3` is hard-blocked** — `Process_functionDlopen` explicitly refuses any
  `better_sqlite3.node`, in both 1.3.14 and main. `prebuild-install` reads the resulting
  `ERR_DLOPEN_FAILED` as "no usable prebuild" and falls back to `node-gyp rebuild`, which the official
  `oven/bun` image cannot satisfy (no Python/g++).
- **node-pty is broken on Bun** (#28925, #25822, #30454) — independently confirming R2's recommendation
  to drop node-pty in favour of `Bun.Terminal`.

## `bun install` gotchas

- **`trustedDependencies` REPLACES the 367-entry default allow-list — it does not extend it.** Adding one
  package silently disables all defaults. (`src/install/default-trusted-dependencies.txt`.)
- The default list applies **only to npm-registry packages**; `file:`, `link:`, `git:`, `github:` must
  always be listed explicitly.
- Trust is **per-package, not transitive**.
- If `binding.gyp` exists and both `install` and `preinstall` are empty, Bun synthesizes
  `node-gyp rebuild`, matching npm.
- **No `--unsafe` npm-parity escape hatch exists** (#23070, open).
- Tooling: `bun pm trust <pkg>`. Failure symptoms: `could not determine executable to run for package`,
  `InvalidExe`.

## Why this mostly doesn't hit us

Yantra's design — arrived at independently in R2, R5 and R6a — uses **zero native addons**:

| Landmine | Yantra's exposure |
| --- | --- |
| `nan` / V8 C++ addons unsupported | **None.** No such dependency planned. |
| `better-sqlite3` blocklisted | **None.** We use built-in `bun:sqlite`, and R6a already ruled out ORMs. |
| node-pty broken | **None.** R2 already moved us to `Bun.Terminal`. |
| libuv polyfills incomplete | **None.** No dd-trace/Sentry/odbc/zeromq. |
| `trustedDependencies` replaces defaults | **Low**, but real the moment we add any dependency. |
| N-API version mismatch | **None.** |
| **Pi 5 page size** | **🔴 Total.** Runtime does not start. |

This is a genuine vindication of the "orchestrate, don't reinvent, shell out to system tools" posture:
almost the entire N-API minefield is irrelevant to us. **The page-size issue is the exception, and it is
the one that matters.**

## Actions for Yantra

1. **Verify Bun on Pi 5 hardware early**, explicitly checking `getconf PAGESIZE`. Document the 4k-kernel
   requirement in the appliance provisioning steps. This gates ADR-0003 trigger T1.
2. **Keep the native-addon dependency count at zero.** Make it an explicit rule, not an accident.
3. **Pin the Bun version** and re-evaluate when 1.4.0 (Rust) ships. Do not adopt canary for the appliance.
4. If any dependency is ever added, remember `trustedDependencies` **replaces** the default list.
5. Track #17627 and the 1.4.0 release as the two Bun events that could change ADR-0003.

## Sources

Accessed 2026-07-28. `registry.npmjs.org/bun`; GitHub `oven-sh/bun` releases, issues, and code search;
raw source at tag `bun-v1.3.14` vs `main` (`src/jsc/bindings/BunProcess.cpp`, `src/napi/napi.zig`,
`src/runtime/napi/napi_body.rs`, `src/install/lockfile/Package/Scripts.rs`,
`src/install/default-trusted-dependencies.txt`); issues #17627, #4290, #18546, #23070, #23685, #25822,
#28925, #30454, #27471, #29260, #16708; PRs #30412, #34146, #34147, #26080, #29981, #30047;
`bun.com/blog/bun-in-rust` (2026-07-08); `bun.com/blog/bun-v1.3.14` (2026-05-13);
`bun.com/docs/runtime/node-api`, `/pm/lifecycle`, `/guides/install/trusted`.
