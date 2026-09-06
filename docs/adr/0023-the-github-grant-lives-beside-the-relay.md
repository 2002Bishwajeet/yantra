# ADR-0023 — The GitHub grant lives beside the relay

- **Date:** 2026-09-06
- **Status:** accepted (2026-09-06, by the owner — Y-334)
- **Closes:** [Q20](../../tracker.md#6-open-questions), *where does a GitHub credential live when
  `yantrad` runs on the appliance*.
- **Amends** [ADR-0021](0021-the-relay-is-written-to-an-environment-file.md), whose *Not decided
  here* said a second secret is a reason to reread it. This is that rereading. It bends
  [ADR-0004](0004-rust-for-the-daemon.md)'s 2026-08-02 amendment a second time, by the same bound
  ADR-0021 set, and reopens **Q5** by exactly one value.

## Context

The dashboard mockup (Y-332 to Y-336) has a New session dialog that browses and searches the
owner's repositories, private ones included, and clones the one picked. The owner ruled on
2026-09-06 that reviews, issues and pull requests come through the same sign-in later, so there is
one GitHub grant and Yantra holds it.

Today Yantra holds none. [`attention.rs`](../../crates/yantra-core/src/attention.rs) reads GitHub
by spawning `gh` where the daemon runs, and its module comment says *Yantra never holds a GitHub
credential, and that is the whole design*. [R13](../research/13-dashboard-revamp-and-github.md)
§2.1 priced the alternative and recommended against it: the daemon holding a token supersedes the
*persists nothing* sentence, reopens Q5, and puts a file on the appliance under an account with no
keyring. Its §2.1 table also found the inversion this ADR has to respect: a GitHub App's 8-hour
token with a rotating refresh is **worse** to hold than an OAuth App's non-expiring one, because
it turns *hold a secret* into *hold a secret and rotate it on a timer*.

R13's recommendation (a) cannot answer the question the dialog asks. *What repositories does this
user have* is not on any machine; it is on GitHub, and asking a machine's `gh` for it means the
appliance's `gh`, whose documented fallback under a `nologin` account is a plaintext file with a
different name (Q20). So the choice was never *hold a secret or not*; it was where.

Four places were weighed on 2026-09-06, on the appliance as
[`docs/appliance.md`](../appliance.md) builds it:

| Place | Why not |
| --- | --- |
| Secret Service keyring (GNOME Keyring, KWallet) | needs a logged-in user session and an unlocked keyring on a session bus; a `nologin` system account has neither |
| systemd credentials (`LoadCredentialEncrypted=`) | an operator encrypts as root before the unit starts and the service can only read; the daemon obtains this token itself at runtime and would need a root helper to store it. Without a TPM the sealing key sits on the same disk as the credential |
| a reference resolved at start (`op://…`, `pass`) | the appliance account has nothing to resolve from; R13 §2.1 (c) shows it becomes (b) at the wire |
| **the environment file the unit already reads** | **chosen** |

**The owner chose the environment file on 2026-09-06.** This ADR records that decision; it does
not explore it.

## Decision

**The daemon obtains an OAuth App token by the device flow, writes it to `/etc/yantra/daemon.env`
beside the relay, and reads GitHub's API with it. Machines never receive it.**

**1. The token is an OAuth App token (`gho_`), which does not expire and issues no refresh token.**
R13 §2.1's inversion is the reason: it is the one credential a daemon that restarts can hold
without a timer. The grant asks for `repo`, `read:org` and `notifications` and nothing more. A
wider scope is a new consent, not a build detail.

**2. It is written to `/etc/yantra/daemon.env` as `YANTRA_GITHUB_TOKEN`, by the write path
ADR-0021 built.** Same file, same `0600`, same owner, same truncate-in-place. ADR-0021's decisions
1, 2 and 5 apply unchanged: the installer creates the file empty, the unit reads it optionally, and
**nothing reads the token back**. No route serves it and no page shows it. The account's login
name, read from the API when the grant is made, is shown; a login is not a secret.

**3. The grant is live when the flow completes and read from the file at the next start.** This
differs from the relay, which ADR-0021 decision 3 reads only at start. The daemon ran the device
flow itself, so it holds the token in memory the moment GitHub returns it, and the file is for the
restart. Making the operator restart a daemon to use a sign-in they just finished on a phone would
be the failure ADR-0016 exists to stop.

**4. The token never leaves the daemon's process.** It reads GitHub's API: the repository list and
search for New session, and the reviews, issues and pull requests the work inbox shows. **A clone
uses the machine's own git credential**, which the doctor's `provider-cli` and `provider-auth`
checks already report. This is R13 §2.2 kept: the value does not cross ssh and does not land on a
command line on a far machine.

**5. The CLI has the verb first**, which is [`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md)'s
standing rule: `yantra github login` runs the device flow and writes the same file; `yantra github
logout` removes the line. The route is that verb on the wire, on ADR-0016's gate like every other
write.

**6. Revocation is rotation.** A non-expiring token is revoked at GitHub, under the owner's
authorised applications, or by `logout`. There is no timer to keep and nothing to refresh.

## Consequences

**§B4 now names two exceptions instead of one, and the sentence that bends is the same one.**
The exposure is exact and unchanged in kind: **on the appliance, whoever can read
`/etc/yantra/daemon.env` has both credentials**, root and the `yantra` account. What a reader can
now do is wider: with the relay token they can publish to a topic; with this one they can read the
owner's private repositories and their notifications until it is revoked. The mode is still the
only mitigation, which is why it is in the decision.

**It bends *the daemon persists nothing* a second time, by the bound ADR-0021 set.** This is
configuration, not state: one of the daemon's own inputs, written so it survives a restart. Nothing
about the fleet is written, and the first look after a start still says nothing.

**Q5 is reopened by one value and no more.** Q5 closed *reference-only, always* and said that
holding secrets means earning encryption at rest, key management, stream redaction and audit. None
of those is built here, and this ADR does not claim they are owed: the token is the owner's own,
on the owner's own box, readable by the owner's own account. Workspaces are untouched. The schema
still has no field for a value and a reference is still resolved at launch on the machine that runs
the agent.

**[`attention.rs`](../../crates/yantra-core/src/attention.rs)'s module comment becomes false when
this is built**, and the `gh` spawn it describes is replaced by an API read with this token. The
doctor's `github` check then asks whether a grant is present and still accepted, and `provider-auth`
keeps asking whether the machine can clone. The mockup's Machine boards already draw them that way.

**The device flow needs a browser somewhere, and not on the appliance.** That is what the device
flow is for: the phone opens `github.com/login/device`, the daemon polls. The sheet in the mockup
draws that and nothing else.

### What was rejected, and why

**A GitHub App**, for the reason R13 §2.1 measured: the better-designed credential is the one a
restarting daemon cannot hold without rotating it every eight hours.

**A pasted fine-grained token.** The first draft of the connect sheet had one. It puts the value
on a clipboard and in a form for no gain the device flow does not give, and a fine-grained token can
expire, which brings the timer back. The sheet now has the device flow only.

**The three places in the table above**, each for the reason beside it. Systemd credentials are the
right answer for a secret an operator provisions once, on a box with a TPM. Neither is true here.
If the appliance gains a TPM, the daemon's read path does not change: it reads the variable from
its environment either way, so the move is an installer change.

### Not decided here

- **Where GitLab's grant goes.** The mockup draws a GitLab row. The same file is the obvious answer
  and it is not taken here.
- **Whether the scope ever widens to write**, for creating pull requests or commenting on issues.
  That is a new consent and a new reading of the exposure paragraph above.
- **Whether the daemon's own `git` should clone with the token for a machine that has no
  credential.** Decision 4 says no. If a machine that cannot clone turns out to be the common case,
  that is R13 §2.6a's manual step made automatic, and it gets its own row.
