# 10 — Claude Code credentials on macOS: can the store be moved off the login keychain?

Access date: **2026-08-03**. Written for [Y-122](../../tracker.md), against
[I-44](../../crates/yantra-core/tracker.md).

> **Scope.** One question, nothing else: *can Claude Code 2.1.x be told to keep its credentials
> somewhere a process launched over SSH on macOS can read — a file, an env var, a helper — instead
> of the macOS login keychain?* If yes, Y-122 is a setting. If no, it is an architecture change.
> This note does **not** design the launchd agent; that is the owner's decision and a separate one.

**Everything here is version-specific to Claude Code `2.1.220`** — the build stamped
`2026-07-24T22:17:45Z` inside the binary, and the same build on both machines, so the version is
controlled rather than assumed. Anthropic moved credential storage to the keychain in a point
release once already (§8); re-measure before relying on any of this.

---

## Bottom line

**Architecture, not a setting.**

No setting, environment variable, or flag in Claude Code 2.1.220 moves the *stored* subscription
credential off the macOS login keychain. The storage location is documented per operating system and
is not configurable on macOS. What exists instead are ways to **supply a credential from outside**:
five precedence levels sit above the keychain, and setting aside the cloud providers — this fleet
has no Bedrock, Vertex or Foundry — four remain. **Each of the four is a secret *value* that Yantra
would have to hold, set, or pass, which [§B4](../../CLAUDE.md) disqualifies outright**, and three of
the four bill against the Anthropic API rather than the owner's subscription.

---

## Summary

- **Storage is per-OS and not a setting.** Official docs: *"On macOS, credentials are stored in the
  encrypted macOS Keychain. On Linux, credentials are stored in `~/.claude/.credentials.json` with
  file mode `0600`."* The one relocation knob, `CLAUDE_CONFIG_DIR`, is documented as applying
  *"on Linux or Windows"* — macOS is excluded by name (§2).
- **Loud negative, and it kills the obvious idea.** The premise behind the most-cited community
  report — *the file is already there, Claude Code just ignores it* — **does not hold on this
  MacBook.** `~/.claude/.credentials.json` **does exist**, mode `0600`, 505 bytes, and is
  **readable from the ssh session**. It contains exactly one key, `mcpOAuth`, holding one plugin's
  MCP OAuth state. There is no `claudeAiOauth` in it. So macOS does not write a Linux-shaped account
  credential and then decline to read it — **it never writes one**, and there is nothing for a
  fallback to find (§2.1).
- **Loud negative, and it is the one that binds Yantra's code.** Every external credential path
  makes `claude auth status` answer `loggedIn: true` **without validating the credential at all**.
  Measured on the MacBook with a deliberately bogus token: `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-bogus`
  → `{"loggedIn": true, "authMethod": "oauth_token"}`. Yantra's I-44 gate in
  [`agent.rs`](../../crates/yantra-core/src/agent.rs) reads exactly that field. **Any env-var answer
  converts a refusal that names its reason back into the healthy-looking useless session
  [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md) added the gate to prevent** — the
  failure just moves to the first model request, where nothing is watching (§3).
- **Exactly one external path keeps the subscription: `CLAUDE_CODE_OAUTH_TOKEN`**, a one-year token
  from `claude setup-token`. Docs, verbatim: *"This token authenticates with your Claude
  subscription and requires a Pro, Max, Team, or Enterprise plan."* It is also, verbatim, *"It does
  not save the token anywhere"* — so the only place to put it is an environment variable, which is a
  long-lived secret value in Yantra's launch path. **§B4 disqualifies it.** Saying so is the point:
  this is the answer that looks like it works (§6).
- **`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` force API billing.** Docs: *"When set, this key
  is used instead of your Claude Pro, Max, Team, or Enterprise subscription even if you are logged
  in."* That is decision-changing and is not a footnote (§4).
- **`apiKeyHelper` still exists and is the only §B4-shaped mechanism here** — it is a *reference*
  (a script that fetches a secret), not a stored value, which is the shape B4 asks for. But its
  output is sent as `X-Api-Key` / `Authorization: Bearer`, the docs class it with the environment
  credentials whose *"organization membership can't be verified"*, and **whether a subscription
  OAuth token works through it is undocumented and was not tested.** It also does not solve the
  stated problem: the helper runs in the same `Background` launchd domain, so anything it reaches
  for in the keychain fails identically (§5).
- **`--bare` is Anthropic shipping the opposite of what Y-122 wants**, and its help text is the
  clearest statement in the product: bare mode *"skips OAuth and the system keychain"* and
  *"Anthropic auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`"*. The one supported no-keychain
  mode costs the subscription by design (§4).
- **Upstream, this is a known problem that has never been triaged.** Four issues describe this exact
  combination — #5515, #5957, #10158, #29816 — spanning 2025-08 to 2026-04. **Three are closed
  `NOT_PLANNED` by the inactivity bot, the fourth `DUPLICATE` by the duplicate bot, and all four are
  now locked. Not one has a maintainer reply.** The only
  remedy the official troubleshooting page offers is `security unlock-keychain`, which wants a
  password and is therefore already refused by §B4 and by I-44 (§8).
- **Undocumented internals exist and are not an answer.** Binary strings turn up
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CLAUDE_CODE_HOST_CREDS_FILE`,
  `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` and `ANTHROPIC_UNIX_SOCKET`. They are undocumented,
  aimed at Anthropic's own hosting, and every one of them still terminates in a secret value.
  Recorded so nobody has to find them again — **not** recorded as a candidate (§7).

---

## 1. What was measured, and where

| | `cachyos-g14` | `bishwajeets-macbook-pro` |
| --- | --- | --- |
| OS | Linux 7.1.3 (CachyOS) | macOS `26.5.1` |
| Claude Code | `2.1.220` | `2.1.220` |
| Binary | `/home/<user>/.local/share/claude/versions/2.1.220`, ELF, not stripped | `/Users/<user>/.local/bin/claude` |
| Reached as | local | Tailscale SSH, `launchctl managername` → **`Background`** |
| Role here | free experimentation, binary string analysis | read-only confirmation of every claim that is macOS-specific |

Three classes of evidence appear below and are labelled:

- **[docs]** — current official documentation, fetched 2026-08-03. Note the doc host moved:
  `docs.claude.com/en/docs/claude-code/*` now `301`s to `code.claude.com/docs/en/*`.
- **[measured]** — run against the real `2.1.220` binary, on the machine named.
- **[binary]** — read out of the shipped executable's string table. Suggestive, not contractual.

Nothing on the MacBook was logged out, no keychain call was made, no `~/.claude*` path was written.
The macOS probes ran with `CLAUDE_CONFIG_DIR` pointed at a `mktemp -d` directory under `/tmp`, which
was removed afterwards; that directory is where the run's `.claude.json` and `backups/` landed
instead of the owner's home.

---

## 2. Where the credential lives — and whether that is a choice

**[docs]** From *Authentication → Credential management*, verbatim:

> * On macOS, credentials are stored in the encrypted macOS Keychain.
> * On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`.
> * On Windows, credentials are stored in `%USERPROFILE%\.claude\.credentials.json` and inherit the
>   access controls of your user profile directory […]
> * If you've set the `CLAUDE_CONFIG_DIR` environment variable **on Linux or Windows**, the
>   `.credentials.json` file lives under that directory instead.

That third bullet is the whole answer to Y-122's question. The only knob that relocates the
credential file names Linux and Windows and **omits macOS**, and no other setting anywhere in the
settings reference selects a credential store. The *Security* page restates the same thing from the
other side: *"API keys and tokens are stored in the macOS Keychain when available, and protected by
file permissions on Windows and Linux."* `when available` is a fallback for a broken keychain, not a
configuration point — and I-44's measurement already shows the keychain reports itself as *present*
from an ssh session while refusing to be read, which is the case that fallback does not cover.

The full settings reference was searched for a credential-store key. There is none. The
authentication-adjacent keys are `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`,
`forceLoginMethod` and `forceLoginOrgUUID` — three cloud-provider helpers and two enterprise
*restrictions*. Settings file paths, for completeness **[docs]**:

| Scope | macOS | Linux |
| --- | --- | --- |
| User | `~/.claude/settings.json` | `~/.claude/settings.json` |
| Project | `.claude/settings.json` | `.claude/settings.json` |
| Project local | `.claude/settings.local.json` | `.claude/settings.local.json` |
| Managed | `/Library/Application Support/ClaudeCode/managed-settings.json` | `/etc/claude-code/managed-settings.json` |
| Managed drop-in | `…/ClaudeCode/managed-settings.d/` | `/etc/claude-code/managed-settings.d/` |

**[measured, MacBook]** No managed-settings file is installed:
`ls: /Library/Application Support/ClaudeCode/managed-settings.json: No such file or directory`. So
nothing organisational is constraining login on this machine — the keychain is the whole story.

### 2.1 The file *is* there, and it is not what everyone assumes

The most-cited community suggestion (#29816, §8) is that `~/.claude/.credentials.json` already
exists on macOS with a valid token and Claude Code simply declines to read it. **On this machine
that premise is false, and the way it is false matters.**

**[measured, MacBook]**

```
$ ls -l ~/.claude/.credentials.json
-rw-------@ 1 <user>  staff  505 Jul 30 22:18 /Users/<user>/.claude/.credentials.json
$ test -r ~/.claude/.credentials.json && echo READABLE
READABLE
```

The file exists, is mode `0600`, and **is readable from the ssh session**. Its top-level keys — read
as key names only, never values — are:

```
['mcpOAuth']
```

One key. It holds the OAuth state for one plugin's MCP server. There is **no `claudeAiOauth`**,
which is exactly the key Linux carries the account token under (I-44). And in the same ssh session:

```
$ claude auth status
{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}
```

So macOS is not writing a Linux-shaped account credential and then refusing to read it. It writes
the file for *other* credential kinds and puts the account token somewhere else entirely. **A
file-fallback feature would have nothing to fall back to**, and copying a Linux `.credentials.json`
onto a Mac has no documented reader. This is the negative finding that removes the cheapest
hypothesis on the table.

---

## 3. Authentication precedence, and what `auth status` actually reports

**[docs]** Verbatim, in order:

> 1. Cloud provider credentials, when `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or
>    `CLAUDE_CODE_USE_FOUNDRY` is set.
> 2. `ANTHROPIC_AUTH_TOKEN` environment variable. Sent as the `Authorization: Bearer` header.
> 3. `ANTHROPIC_API_KEY` environment variable. Sent as the `X-Api-Key` header.
> 4. `apiKeyHelper` script output.
> 5. `CLAUDE_CODE_OAUTH_TOKEN` environment variable. A long-lived OAuth token generated by
>    `claude setup-token`.
> 6. Subscription OAuth credentials from `/login`. This is the default for Claude Pro, Max, Team,
>    and Enterprise users.

Level 6 is the one in the keychain. Levels 2–5 are the ways to reach past it.

**[measured]** `claude auth status --json` (the default; `--text` also exists) against the real
binary. On Linux the baseline used an empty `CLAUDE_CONFIG_DIR`; on the MacBook it used a throwaway
one under `/tmp`. Every token below is deliberately **bogus**.

| Credential supplied | `cachyos-g14` | `bishwajeets-macbook-pro` |
| --- | --- | --- |
| *(none)* | `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}` | same |
| `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-bogus` | `{"loggedIn":true,"authMethod":"oauth_token",…}` | **same** |
| `ANTHROPIC_API_KEY=sk-ant-bogus` | `{"loggedIn":true,"authMethod":"api_key",…,"apiKeySource":"ANTHROPIC_API_KEY"}` | **same** |
| `ANTHROPIC_AUTH_TOKEN=bogus` | `{"loggedIn":true,"authMethod":"oauth_token",…}` | not run |
| `--settings '{"apiKeyHelper":"echo sk-ant-helper"}'` | `{"loggedIn":true,"authMethod":"api_key_helper",…,"apiKeySource":"apiKeyHelper"}` | **same** |

Two things fall out of that table, and the second is the important one.

1. **The env paths do work on macOS** — they are read in the `Background` launchd domain and reach a
   `loggedIn: true` without a keychain read succeeding. So the mechanism is not blocked by the thing
   that blocks I-44.
2. **`auth status` does not validate anything.** A string that could not possibly authenticate
   produces `loggedIn: true`. The shape grows too: one field Yantra's `Status` does not model
   (`apiKeySource`) and three `authMethod` values beyond the `claude.ai` / `none` pair seen so far
   (`oauth_token`, `api_key`, `api_key_helper`). `serde` drops what is not named and `authMethod` is
   already a `String`, so nothing breaks — the gate simply *passes*.

Point 2 is what makes every env-var answer worse than no answer. ADR-0011 made `auth status` a
pre-launch gate specifically so I-44 could not produce a running, healthy-looking, useless session.
Feed the gate an environment credential and it reports health again — only now the failure surfaces
at the first model request, inside a TUI in a detached tmux pane, which is the exact shape of
silence I-44 and I-25 are both about. **A remedy that defeats the detector is a worse position than
the blocker.**

---

## 4. What each path costs

| Path | Billing | §B4 | Fixes I-44? |
| --- | --- | --- | --- |
| `/login` → keychain (status quo) | **Subscription** | fine — Yantra holds nothing | no, this *is* I-44 |
| `CLAUDE_CODE_OAUTH_TOKEN` | **Subscription** [docs] | **disqualified** — a one-year secret value in Yantra's launch environment | yes, and defeats the gate (§3) |
| `ANTHROPIC_API_KEY` | **API billing** | **disqualified** — secret value | yes, and defeats the gate |
| `ANTHROPIC_AUTH_TOKEN` | **API billing** (gateway/proxy bearer) | **disqualified** — secret value | yes, and defeats the gate |
| `apiKeyHelper` | **API billing**, as far as the docs commit (§5) | *shape* is fine — a reference, not a value | no — the helper runs in the same `Background` domain |
| Bedrock / Vertex / Foundry | **cloud provider billing** | n/a | listed for completeness; this fleet uses none |
| `security unlock-keychain` | Subscription | **disqualified** — needs a password | in principle; already refused by I-44 |

The subscription-vs-API split is the line the owner has to see, so to state it without hedging:
**the only external credential that keeps the subscription is `CLAUDE_CODE_OAUTH_TOKEN`, and it is
the one §B4 most clearly forbids** — a value, long-lived, that Yantra would set into the environment
of every agent it launches.

---

## 5. `apiKeyHelper` — still current, and the honest limits of what it buys

**[docs]** It exists in 2.1.220 and is documented:

> Custom command, run through the system shell (`/bin/sh` on macOS and Linux, `cmd` on Windows), to
> generate an auth value. This value will be sent as `X-Api-Key` and `Authorization: Bearer` headers
> for model requests. Set the refresh interval with `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`

Operational detail **[docs]**: called *"after 5 minutes or on HTTP 401 response"*; a helper slower
than 10 s draws a warning in the prompt bar; from v2.1.208 a helper that errors, times out or prints
nothing fails the request with `Your apiKeyHelper script is failing` **within three attempts**
(before 2.1.208 it surfaced as a generic 401 after roughly ten silent retries). It is also
hot-reloaded — *"Claude Code watches your settings files and reloads them when they change […]
including permissions, hooks, and credential helpers like `apiKeyHelper`"*.

**[measured]** It can be supplied without touching any file on disk:
`claude --settings '{"apiKeyHelper":"echo …"}' auth status` reports
`"authMethod":"api_key_helper"`, on both machines.

Three reasons it is not the answer, in decreasing order of how much they hurt:

1. **It does not address the keychain.** The helper is a shell command spawned by `claude`, in
   `claude`'s process tree, in the `Background` launchd domain. A helper that reaches for the login
   keychain — directly, or via `op`, or via anything with a GUI-bound unlock — fails exactly as
   I-44 describes. The helper only helps if the secret is somewhere the `Background` domain can
   already read, and if such a place existed Y-122 would not exist.
2. **Billing.** The docs never state that helper output may be a subscription OAuth token. They
   group it with the environment credentials that *"can't be verified"* for organization membership,
   the error strings in the binary treat it as the API-key branch (**[binary]**: *"Your organization
   has disabled API key authentication · Unset the `apiKeyHelper` setting and run `/login` to sign
   in with your claude.ai account"*), and `auth status` labels it `api_key_helper`. **Whether a
   `setup-token` OAuth token authenticates through `apiKeyHelper` is undocumented, and this note did
   not test it** — testing it means minting a one-year credential, which is itself the §B4 problem.
3. It runs, per **[binary]**, guarded by a workspace-trust check (*"Security: `apiKeyHelper`
   executed before workspace trust is confirmed"*), which interacts with I-23/I-49 in ways nobody
   has mapped.

The shape is right and everything else about it is wrong. Worth saying plainly because
`apiKeyHelper` is what a reader of §B4 will reach for first.

---

## 6. `claude setup-token`

**[measured]** Present in 2.1.220: `claude setup-token — Set up a long-lived authentication token
(requires Claude subscription)`. It takes no options.

**[docs]**, verbatim and complete on the two points that decide it:

> The command opens the same browser authorization flow as `/login`, and the token prints to the
> terminal after you approve access in the browser. **It does not save the token anywhere**; copy it
> and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to
> authenticate.

> This token authenticates with your Claude subscription and requires a Pro, Max, Team, or
> Enterprise plan. It can only make model requests, so it can't establish Remote Control sessions or
> fetch claude.ai connectors. MCP servers you configure locally still work.

**A correction to the widely repeated claim, and it cuts in Anthropic's favour.** Issue #10158
(2025-10-23, v2.0.25) says *"the `claude setup-token` workaround switches to API key pricing, which
defeats the point of having a subscription."* That is quoted all over the internet and **it is no
longer true of 2.1.220** — the current docs say the opposite in as many words. It is a one-year
subscription credential. It is still disqualified here, but for §B4, not for billing, and the
distinction matters because the two failure modes have completely different fixes.

Not run: `claude setup-token` itself. It would mint a real one-year credential for the owner's
account, which is a state change and a secret, and the answer it produces is already disqualified.

---

## 7. The negative search: settings and env vars that do not exist

The settings reference has no credential-store key (§2). To be sure the documentation was not simply
behind the binary, the shipped executable's string table was searched directly.

**[binary]** — `strings` over the 2.1.220 ELF. The keychain read path is visible verbatim as the
argv `security` / `find-generic-password` / `-a` / `-w` / `-s`, alongside a `[secureStorage]` module
carrying `storageDir`, `storagePath`, `.credentials.json`, and a full set of `errsec*` mappings
including `errsecinteractionnotallowed` → `interaction_not_allowed`, which is precisely the failure
I-44 measured. **There is no `useKeychain`, no `credentialStore`, no `disableKeychain`, and no
platform override of any kind** in the settings surface.

What the string table *does* contain, and what each is:

| Symbol | What it appears to be | Why it is not the answer |
| --- | --- | --- |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | relocates the secure-storage module's config directory | **[measured]** setting it changed nothing about `auth status` and created no directory. Not a store selector. |
| `CLAUDE_CODE_HOST_CREDS_FILE` | a credentials file supplied by a *host*; validated for ownership and mode (**[binary]**: *"ignoring `CLAUDE_CODE_HOST_CREDS_FILE` with group/other-readable mode or wrong owner"*) | undocumented, built for Anthropic's own hosted runners, and it is a **secret in a file** — §B4 |
| `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` | pass a credential over an inherited fd | undocumented; still a secret value, just a tidier delivery of one |
| `ANTHROPIC_UNIX_SOCKET` | route model requests through a Unix socket to a proxy that *"can enforce domain allowlists, **inject credentials**, and log all traffic"* [docs, agent-sdk/secure-deployment] | this is a *transport*, not a store. The credential moves to whatever holds the other end of the socket — which is an architecture, and a different one than the launchd agent. |
| `CCR_OAUTH_TOKEN_FILE`, `unix_socket_ssh_under_pin` | Anthropic's hosted-environment plumbing | not user-facing |

Recorded so the next person does not have to run `strings` again. **None of these is a supported
configuration and none should be built on.** Every one still ends at a secret value that something
has to hold.

The one place Anthropic *does* ship a documented no-keychain mode is `--bare`, and its own help text
states the price **[measured, `claude --help`]**:

> Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches,
> **keychain reads**, and CLAUDE.md auto-discovery. […] Anthropic auth is strictly
> `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and keychain are never read).

The headless docs say the same: *"Bare mode skips OAuth and the system keychain […] Set
`ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your subscription login."* The
supported way to avoid the keychain is to stop using the subscription. That is the product's
position, stated three times in three places.

---

## 8. Upstream: reported four times, triaged zero times

Searched `anthropics/claude-code` on 2026-08-03. The exact macOS-keychain-over-ssh combination:

| Issue | Opened | Closed | Reason | Maintainer reply? |
| --- | --- | --- | --- | --- |
| [#5515](https://github.com/anthropics/claude-code/issues/5515) *"[BUG] [SOLVE!] Missing API key when SSH'ing into macOS"* | 2025-08-10 | 2026-01-09 | `NOT_PLANNED` | **no** |
| [#5957](https://github.com/anthropics/claude-code/issues/5957) *"macOS Keychain: SSH Authentication Failure for Pro Plan Users"* | 2025-08-17 | 2026-01-09 | `NOT_PLANNED` | **no** |
| [#10158](https://github.com/anthropics/claude-code/issues/10158) *"[BUG] SSH sessions can't authenticate on macOS"* | 2025-10-23 | 2025-10-26 | `DUPLICATE` | **no** |
| [#29816](https://github.com/anthropics/claude-code/issues/29816) *"SSH sessions require re-login despite valid `~/.claude/.credentials.json` (macOS Keychain unavailable)"* | 2026-03-01 | 2026-04-10 | `NOT_PLANNED` | **no** |

The closing comments read by hand were both written by `github-actions` — #5957's *"automatically
closed due to 60 days of inactivity"*, #29816's *"Closing for now — inactive for too long."* All
four are now locked. **A year of reports, and no human at Anthropic has answered any of them.** That
is itself the finding: this
is not an oversight waiting on a doc fix, it is a case Anthropic has not engaged with, so nothing
should be planned on the assumption it changes.

The substance of the reports, which corroborates I-44 independently:

- #5957 dates the regression to the changelog line *"(Mac-only) API keys in macOS Keychain"* — so
  ssh-to-Mac **worked before** the keychain migration. This is a regression Anthropic introduced,
  not a macOS constraint that was always there.
- #10158 lists four workarounds that all fail — `security unlock-keychain`,
  `security set-generic-password-partition-list`, duplicating the keychain item under a second
  service name, and setting *Always Allow* locally before ssh-ing. It also names the comparison that
  stings: `gh` keeps tokens in `~/.config/gh/`, `gcloud` in `~/.config/gcloud/`, and both work over
  ssh for that reason.
- #29816's requested fix is precisely Y-122's question — *"When the macOS Keychain is unavailable or
  locked, fall back to reading credentials from `~/.claude/.credentials.json`"* — and it was closed
  without comment. Its premise about that file does not hold here anyway (§2.1).
- #5515's *"[SOLVE!]"* is `security unlock-keychain ~/Library/Keychains/login.keychain-db`, run
  interactively so it can prompt for the password. §B4, and I-44 already recorded it.

The official troubleshooting page offers exactly one macOS keychain remedy, and it is the same one
**[docs]**: *"To unlock the Keychain manually, run
`security unlock-keychain ~/Library/Keychains/login.keychain-db`."* There is no ssh guidance, no
headless guidance, and no mention of the `Background` launchd domain anywhere in the documentation.

---

## 9. What this note does not answer

- **Whether `apiKeyHelper` can return a subscription OAuth token.** Undocumented; not tested,
  because testing it requires minting a real long-lived credential (§5).
- **Whether a tmux server or launchd agent started in `gui/<uid>` inherits keychain access.** Still
  untested, still the promising direction, and deliberately out of scope — Y-122's row already says
  it is an ADR-shaped decision for the owner, and I-44 records that `launchctl asuser` needs root so
  it cannot be checked over ssh.
- **Whether `ANTHROPIC_UNIX_SOCKET` could carry a credential from a GUI-domain process to an ssh
  one.** It is documented only as a network-isolation transport for containers. Naming it is not
  proposing it.
- **Anything about a second agent CLI.** Codex, Gemini and the rest were not looked at; the
  one-agent-first guardrail holds.

Deliberately not done: no `/login`, no `/logout`, no `claude setup-token`, no keychain call, no
`sudo`, and no write under `~/.claude*` on the MacBook.

---

## Sources

All retrieved **2026-08-03** unless noted. The Claude Code documentation host moved during this
research: `docs.claude.com/en/docs/claude-code/*` returns `301 Moved Permanently` to
`code.claude.com/docs/en/*`, and the canonical URLs below are the redirect targets.

**Official documentation**
- [code.claude.com/docs/en/iam](https://code.claude.com/docs/en/iam) — *Authentication*: credential
  management per OS, the six-level precedence list, `apiKeyHelper` refresh and failure behaviour,
  `claude setup-token`, `forceLoginMethod` / `forceLoginOrgUUID`
- [code.claude.com/docs/en/settings](https://code.claude.com/docs/en/settings) — settings reference
  and settings-file paths for macOS and Linux
- [code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars) — `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`
- [code.claude.com/docs/en/security](https://code.claude.com/docs/en/security) — *Secure credential
  storage*
- [code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless) — bare mode and its
  auth constraints
- [code.claude.com/docs/en/devcontainer](https://code.claude.com/docs/en/devcontainer) — the
  documented remote/CI credential path (`CLAUDE_CONFIG_DIR` volume, or `CLAUDE_CODE_OAUTH_TOKEN` as
  a secret)
- [code.claude.com/docs/en/troubleshoot-install](https://code.claude.com/docs/en/troubleshoot-install)
  — the only official macOS keychain remedy
- [code.claude.com/docs/en/agent-sdk/secure-deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)
  — the Unix-socket proxy architecture
- [code.claude.com/docs/llms.txt](https://code.claude.com/docs/llms.txt) — page index used to
  confirm no other page covers credential storage

**Public issue tracker** (`anthropics/claude-code`, via `gh issue view` / `gh search issues`)
- [#5515](https://github.com/anthropics/claude-code/issues/5515) · opened 2025-08-10, closed
  2026-01-09 `NOT_PLANNED`
- [#5957](https://github.com/anthropics/claude-code/issues/5957) · opened 2025-08-17, closed
  2026-01-09 `NOT_PLANNED`
- [#10158](https://github.com/anthropics/claude-code/issues/10158) · opened 2025-10-23, closed
  2025-10-26 `DUPLICATE`
- [#29816](https://github.com/anthropics/claude-code/issues/29816) · opened 2026-03-01, closed
  2026-04-10 `NOT_PLANNED`

**Measured against the real binary**, Claude Code `2.1.220` (build stamp `2026-07-24T22:17:45Z`)
- `cachyos-g14` — `claude --help`, `claude auth --help`, `claude auth status --help`,
  `claude setup-token --help`, `claude auth status` under each credential in §3, and `strings` over
  `/home/<user>/.local/share/claude/versions/2.1.220`
- `bishwajeets-macbook-pro`, over Tailscale SSH, read-only — `sw_vers`, `claude --version`,
  `launchctl managername`, `ls -l ~/.claude/.credentials.json`, its top-level key names,
  `claude auth status` at default and under each credential in §3. Probes ran with
  `CLAUDE_CONFIG_DIR` in a `mktemp -d` under `/tmp`, removed afterwards.

**Yantra internal** — [`CLAUDE.md`](../../CLAUDE.md) §B4 and §B6;
[`tracker.md`](../../tracker.md) rows Y-113 and Y-122 and risk R-21;
[`crates/yantra-core/tracker.md`](../../crates/yantra-core/tracker.md) I-25 and I-44;
[`crates/yantra-core/src/agent.rs`](../../crates/yantra-core/src/agent.rs) `Status` and `ready`;
[ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md).
