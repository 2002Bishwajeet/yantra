# ADR-0032 — The appliance keeps every machine's conversation history, redacted and encrypted on its disk

- **Date:** 2026-10-05
- **Status:** Accepted 2026-10-05. The owner answered Q22 that day ([Y-426](../../tracker.md)).
- **Evidence:** [R18](../research/18-one-conversation-history.md), 2026-10-05. Its §11 holds the
  trial of `cass` and `ctx` and the three designs.
- **Amends** the rule that the appliance stores nothing, in
  [ADR-0004](0004-rust-for-the-daemon.md)'s 2026-08-02 amendment. **yantrad still persists nothing.**
- **Reads against** [ADR-0015](0015-resume-forks-the-conversation.md) for resume, and
  [ADR-0021](0021-the-relay-is-written-to-an-environment-file.md) and
  [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) for the two credentials the appliance
  already holds.

## Context

The owner wants one conversation history on every machine. It must serve every agent harness:
Claude Code, Codex, Gemini, Grok and others. The owner wants to search all history from one place,
and to continue a session on any machine. A machine that is off must not take its history with it.

R18 found that no harness syncs its own sessions, and that no shared transcript format exists. It
compared three designs: the appliance as a hub (H), a peer mesh (M) and no store (C+S). H gives the
best search and keeps the history of a machine that is off. Its cost is a copy of every
conversation on the appliance.

R18 §11.3 measured redaction. `gitleaks` found all 15 fake tokens in 31 MB in 2.8 s. It missed a
`DATABASE_PASSWORD=` line. So redaction makes a leak smaller. It does not make the copy safe.

The owner refused a plaintext copy. Asked who holds the key, the owner chose encryption on the
appliance's disk with the key on the appliance. They accepted the cost that this option stated:
it protects a removed disk, and it does not protect a running appliance that someone gets into.
End-to-end encryption would protect that case, but then only the machines could search.

## Decision

1. **The appliance keeps a copy of every machine's conversation history.** It is design H in R18
   §11.4. A copy stays on the appliance after the harness on the machine deletes its own.
2. **Each machine redacts before it sends.** A job on the machine writes a redacted staging copy
   with `gitleaks` and the rules R18 §11.3 lacked. The live transcript stays whole, because
   `--resume` needs it whole. The appliance never receives the unredacted text.
3. **Syncthing moves the files.** Each machine's staging folder is *send only*. The appliance's
   folder is *receive only*, with `ignoreDelete`. One writer per path means no conflict files.
4. **The archive is encrypted on the appliance's disk.** The archive and the search index live
   only inside an encrypted volume. The key must not be on the same disk in a form that opens it.
   A disk taken out of the appliance shows only ciphertext.
5. **`ctx` indexes the archive on the appliance and serves it to agents over MCP.** Its analytics
   and its auto-upgrade are off. `cass` is out: its indexing peak was 5.9 GB, and its licence rider
   excludes Anthropic and OpenAI (R18 §11.1).
6. **yantrad stays out of the data path.** Syncthing, the redaction job and `ctx` do the storing.
   yantrad persists nothing, and the CLAUDE.md §B1 rule holds for it.
7. **Resume copies one session from the appliance to the target machine over ssh.** That copy is
   the redacted file. The ADR-0015 fork rules apply unchanged.
8. **The history is optional and off by default.** The owner turns it on per appliance. A person
   who never turns it on gets an appliance that stores nothing.

## Consequences

**Gained.** One search over all machines and all harnesses, from any agent through MCP. The
history of a machine that is off. Retention past each harness's own cleanup, such as Claude Code's
30-day sweep. A removed disk leaks nothing.

**Cost: the running appliance can read everything.** Someone who gets a shell on it reads the
archive and the index. Some secrets survive redaction (R18 §11.3), so they can read those too.

**Cost: the appliance stores conversations.** This is a third kind of data on the appliance after
the two credentials of ADR-0021 and ADR-0023. It is not a credential, and the §B4 exceptions do not
cover it. The archive must not grow into a store for anything else.

**Cost: setup and resources.** Every machine runs Syncthing and a redaction job. The appliance runs
Syncthing and the `ctx` daemon: about 216 MB at rest and 985 MB while indexing on x86-64 (R18
§11.2), inside the owner's 4 GB budget. `ignoreDelete` grows the disk without bound, so the archive
needs a prune rule.

**Not yet measured.** Every figure on arm64 and on a Pi. Where the key comes from so that a removed
disk cannot open it: the Pi 5's OTP private key is a candidate, and a build row must verify it.
Whether a redacted transcript still resumes under `claude --resume`. `ctx` over real Codex, Gemini
and Grok history. The build rows carry these checks.
