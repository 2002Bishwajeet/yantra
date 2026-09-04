# Architecture

What Yantra is, how a command actually reaches a machine, what protects what, and where it is going.

Diagrams are Mermaid, which GitHub renders inline — no build step, no generated assets, nothing to
regenerate when the code changes. If a diagram disagrees with the code, the code is right and the
diagram is a bug.

**Status labels below mean what they say.** Solid lines exist and are tested; a dashed line is
annotated with what it means, and as of M6 none of them means *planned*. This file is not a
proposal — the proposals live in [`docs/plans/`](plans/).

---

## 1. The shape today

Yantra orchestrates programs that already work. It does not reimplement a terminal multiplexer, an
SSH client, or a VPN — that constraint is §B2 of [`CLAUDE.md`](../CLAUDE.md) and it is the single
biggest reason the codebase is small.

```mermaid
flowchart TB
    you(["you, at a terminal"])
    browser(["a browser on the tailnet"])

    subgraph host["your machine"]
        cli["yantra<br/>the CLI — renders, picks exit codes,<br/>decides nothing"]
        daemon["yantrad<br/>the daemon — the read model, the dashboard,<br/>and a pty per attached terminal"]
        core["yantra-core<br/>every decision lives here<br/>never prints, never exits"]
        tsd["tailscaled"]
        gh["gh<br/>your own GitHub login, in its keyring"]
    end

    subgraph target["any machine on the tailnet"]
        tmux["tmux session<br/>outlives your connection"]
        claude["claude<br/>a TUI, in the pane"]
        jsonl[("transcript JSONL<br/>the agent's own journal")]
    end

    you --> cli
    browser -->|"7717 plain, 8443 HTTPS<br/>via tailscale serve"| daemon
    cli --> core
    daemon --> core
    core -->|"system ssh<br/>ControlMaster multiplexed"| tmux
    core -->|"tailscale status --json<br/>read-only, advisory"| tsd
    daemon -->|"gh api, every 300 s<br/>no token reaches Yantra"| gh
    tmux --> claude
    claude --> jsonl
    jsonl -->|"read back by yantra logs"| core
```

Nothing in that diagram is dashed any more. The browser edge was drawn planned through M4, and the
whole of it — the read model, the dashboard, and since M6 a live pane — now exists. The `gh` edge is
M11's: the work inbox reads the pull requests and issues waiting on you through the `gh` already
logged in on this machine, so the daemon holds no credential of its own.

**Four crates, and only one of them thinks.**

| Crate | Job | State |
| --- | --- | --- |
| [`yantra-core`](../crates/yantra-core/README.md) | All orchestration: ssh, tmux, agents, inventory, workspaces. Never prints, never exits ([ADR-0005](adr/0005-core-logic-in-a-library-crate.md)). | **Nearly all the code** |
| [`yantra`](../crates/yantra/README.md) | The CLI. Layout, wording, exit codes. | Working; every verb the dashboard has, and `ls attention` |
| [`yantrad`](../crates/yantrad/README.md) | The daemon. An HTTP surface over the same library, plus the dashboard and a pty per attached terminal. | Serves the read model, control, and a live terminal |
| [`yantra-agent`](../crates/yantra-agent/README.md) | Per-machine heartbeat, so a person choosing a machine can see a sleeping laptop. | Probes and reports, on a 10 s tick |

The CLI and the daemon are **two callers of one library**, not a stack —
[ADR-0012](adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md). `yantra` keeps working
on a machine where `yantrad` was never started.

---

## 2. What actually happens on `yantra up`

The interesting parts are the ones that are not obvious: the agent's account is checked **before**
tmux is touched, and the command crosses the wire base64-encoded so nothing needs quoting.

```mermaid
sequenceDiagram
    autonumber
    actor you
    participant cli as yantra
    participant core as yantra-core
    participant ssh as system ssh
    participant mach as the machine

    you->>cli: yantra up yantra --agent claude
    cli->>core: up::up("yantra", TERM, Agent::Claude)
    core->>core: read ~/.config/yantra/workspaces/yantra.toml
    Note over core: machine, repo, startup.<br/>An unknown key is an error, not a shrug.

    core->>ssh: locate claude, check the account
    ssh->>mach: base64 payload → /bin/sh
    mach-->>core: path + auth status
    Note over core,mach: Checked BEFORE tmux is touched, so a machine<br/>that cannot run an agent leaves nothing half-open.

    core->>ssh: tmux new-session -d
    ssh->>mach: creates the session
    Note over core,mach: "duplicate session:" counts as success —<br/>the two obvious ways to do this are both wrong (I-1).

    core->>ssh: set remain-on-exit, then respawn-pane
    Note over mach: The pane's process IS the agent,<br/>so how it ends stays readable (I-4, I-29).
    mach->>mach: cd repo && exec claude --session-id (the id Yantra chose)

    core-->>cli: Opened::Created + the attach hint
    cli-->>you: the exact ssh command to attach
```

Running it again attaches instead of duplicating. Idempotency is designed in, not bolted on (§B4).

Afterwards, three commands read that session without ever sending it a keystroke:

```mermaid
flowchart LR
    subgraph reads["reading a live session"]
        s["yantra status"] --> pane["tmux pane<br/>alive? exit status? signal?"]
        s --> reg["claude agents --json<br/>the agent's own registry"]
        l["yantra logs"] --> tr[("transcript JSONL")]
        d["yantra down"] --> term["SIGTERM, wait, then kill-session"]
    end
    pane --> verdict{{"running · finished · stopped<br/>crashed · killed · unclear"}}
    reg --> verdict
```

`status` reads **two independent sources and reports their disagreement rather than resolving it**.
Where they contradict each other the answer is `unclear` *with its reason attached* — never a guess.
That design earned itself immediately: a signal-killed pane leaves the exit status **empty**, so
anything defaulting it to zero reports a `kill -9` as a clean finish (I-47).

---

## 3. Security, and what is actually protecting what

The honest version, including the parts that are policy rather than code.

```mermaid
flowchart TB
    internet(["the public internet"])

    subgraph tailnet["the tailnet — WireGuard, the only perimeter"]
        subgraph host["your machine"]
            cli["yantra"]
            daemon["yantrad<br/>binds tailnet addresses only<br/>reads open · writes and terminal owner-gated"]
        end
        subgraph managed["a managed machine"]
            sshd["sshd or Tailscale SSH"]
            shell["/bin/sh"]
        end
    end

    internet -.->|"no listener,<br/>no port forward"| tailnet
    cli -->|"key auth, BatchMode=yes<br/>no password prompt, ever"| sshd
    daemon -->|"the same ssh, on the refresh's<br/>own schedule"| sshd
    sshd --> shell
    shell -->|"base64 payload —<br/>nothing is shell-quoted"| shell

    classDef danger fill:#5a1e1e,stroke:#c04040,color:#fff
    class internet danger
```

### What each layer does

| Boundary | Mechanism | Verified |
| --- | --- | --- |
| Nothing is publicly reachable | `yantrad` binds only the addresses Tailscale reports for **this** machine, and **refuses to start** if it cannot learn them | ✅ `ss -ltnp` shows the tailnet addresses and no `0.0.0.0`; `curl 127.0.0.1:7717` is refused |
| No auth on the **read** API | Deliberate. Q6 settled that Yantra is personal-first, so for reads the bind address **is** the security model (R-22) | ⚠️ a design decision, not a control — see below |
| Anything that **acts** | `up`, `down`, `resume` and the terminal socket resolve the caller with `tailscale whois` and refuse unless it is the tailnet's owner ([ADR-0016](adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)). A proxied hop is only trusted to name the caller when the hop is ours ([ADR-0017](adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)) | ✅ tested, including a forged `Forwarded` header |
| Remote command injection | Every command crosses as **base64 decoded by `/bin/sh` on the far side**, so a hostile `repo` path stays an argument. POSIX quoting was tested and breaks on an embedded newline (I-26) | ✅ tested against a real `/bin/sh`, with a hostile path |
| Host identity | `UserKnownHostsFile` in Yantra's own state dir, `StrictHostKeyChecking=accept-new` | ✅ |
| Credentials on disk | Yantra stores **none**. It never asks for a password: `BatchMode=yes` means a machine that wants one fails instead of prompting | ✅ |
| Agent account tokens | Yantra never reads them. `claude auth status` prints an email, an org id and a subscription type; the struct that parses it **names only two fields**, so the rest cannot reach a log line | ✅ a deliberate privacy boundary |
| Secrets in workspaces | **Policy, not yet code.** The schema has no secrets field at all. When it gains one it holds a *reference* (`op://…`, `pass show …`, a sops path) resolved at launch and never written to disk, logs, the API or a terminal stream | ⬜ not implemented — Q5 |
| The notifier's relay | The first secret Yantra actually holds (Y-146). A `Relay` is a URL and an optional token, in memory only — never a workspace field, never the API, never a log line. Its `Debug` is written by hand and redacts **both**: the token by §B4, and the URL because on a public relay the topic is the password | ✅ tested — neither survives being printed, and no error carries either. It arrives from the unit's environment (`YANTRA_NTFY_URL`, `YANTRA_NTFY_TOKEN`), and since Y-199 that environment can come from a file the dashboard writes — `/etc/yantra/daemon.env`, `0600`, owned by the daemon's account, holding the token in plain text ([ADR-0021](adr/0021-the-relay-is-written-to-an-environment-file.md)). That is the one place Yantra holds a secret **value**, and the row above is why it is written down as an exception rather than folded in |

### The two things to understand before trusting this

**`yantrad` has no authentication, on purpose.** Anyone who can reach your tailnet on port 7717 can
read everything it exposes — machine names, workspace names, repo paths. That is an accepted
consequence of Q6 (personal-first), and it is why the bind address is treated as a security control
rather than a convenience: there is **no `--bind` flag and no `--port` flag**, because a flag that can
expose the API is a flag someone eventually passes. If you share a tailnet with people you would not
give a shell to, do not run the daemon yet.

**A workspace file is a code-execution path.** `machine` and `repo` come from a file on disk and end
up in a remote shell. They are quoted as such, with tests that assert the exact string *and* prove the
behaviour on a real shell — but treat `~/.config/yantra/workspaces/` with the same care as `~/.ssh/`.

---

## 4. Where the live risks sit

Every risk in [`tracker.md`](../tracker.md) §7 attaches to a component. Retired ones are omitted.

```mermaid
flowchart TB
    subgraph now["shipped, and carrying risk"]
        d["yantrad<br/>R-22 the bind address is the whole security model<br/>R-23 a cached dashboard tells confident lies"]
        a["agents on macOS<br/>R-21 the login keychain is unreachable over ssh"]
        w["Windows<br/>R-7 no tmux, and Tailscale SSH cannot serve it"]
    end
    q{{"Q4 is deliberately open —<br/>the only Windows node is a<br/>dual boot of a Linux one,<br/>so supporting Linux costs zero machines"}}
    w -.-> q
```

**Nothing carrying risk is unbuilt any more.** **R-24 — the JS toolchain leaking into the Rust
build — retired on 2026-08-06**, and it retired by enforcement rather than by observation: Y-148 runs
the gate's own `build` and `lint` on a runner with `node`, `npm` and `npx` shadowed by stubs that exit
127. The risk is now a job that has been watched failing, rather than a condition nobody was testing.

**R-7 (Windows) is the top risk and is not being worked on.** That is a choice, recorded rather than
forgotten: the tailnet's only Windows node is the second boot of a machine that already runs Linux,
so supporting Linux alone costs zero machines. Note that a green Windows build proves nothing here —
what compiles for Windows is `yantra-agent`, which probes and heartbeats and opens no session at all.
Windows' actual problem is having no tmux.

**R-21 (macOS agents cannot authenticate over ssh)** is real and unfixed. It costs a target rather
than the project, because reaching a Linux machine *through* the Mac sidesteps it entirely — one
`ProxyJump` line in `~/.ssh/config`, and no Yantra code at all. The Mac itself now has an accepted
decision — [ADR-0018](adr/0018-the-tmux-server-carries-the-macos-login-session.md), which keeps ssh
as the only transport and gives `yantra-agent` no new job — whose §1 and §5 are built and, since
2026-08-05, measured on that machine (Y-151): inside a tmux server started at the Mac's own keyboard
the gate finds a credential where ssh in the same run finds none. The risk retires when M7 installs
the ADR's §7 launchd job, which is what puts such a server there with nobody at the keyboard.

---

## 5. Where this is going

```mermaid
flowchart LR
    M1["M1 · walking skeleton"] --> M2["M2 · real machines"] --> M3["M3 · agents"] --> M4["M4 · web UI"] --> M5["M5 · control from the phone"] --> M6["M6 · browser terminal"] --> M7["M7 · appliance"] --> M8["M8 · hardware panel"] --> M9["M9 · enclosure & PCB"] --> M10["M10 · placement"]

    M6 --> M11["M11 · work inbox"] --> M12["M12 · sessions and cost"] --> M13["M13 · a dashboard you can work in"]

    classDef done fill:#1e4620,stroke:#3fb950,color:#fff
    classDef doing fill:#3d2e00,stroke:#d29922,color:#fff
    class M1,M2,M3,M4,M5,M11,M12,M13 done
    class M6,M7 doing
```

**M11, M12 and M13 closed on 2026-09-04, and they were dashboard work rather than new orchestration.**
`/` opens on what needs you: the GitHub queue as a band with its own clock, then every tmux session
on the fleet, whether a workspace names it or not, each one attachable and killable from the page.
A workspace page carries three tabs — the terminal, the transcript read on request, and what the
session spent — and each tab names the machine it could not reach. M13's phone clause, *three
screens and one tap*, is built and not yet measured on a phone.

**M6 and M7 are both open for reasons that are not code.** M6's layers are all built and each is
tested against something real; what it waits on is one run against
`bishwajeets-macbook-pro`, and [ADR-0018](adr/0018-the-tmux-server-carries-the-macos-login-session.md)
§1 makes that unrunnable from anywhere but that keyboard. M7's demo is *runs 24/7 and survives
reboot*, and no such machine is on the tailnet yet — so the supervision, the notifier and the install
path get built against machines that exist, and the reboot is not faked.

**Placement was M5 and is now M10.** Re-scoped by the owner on 2026-08-02: two machines, one of which
is usually the right answer, needs a list to tap rather than a scheduler. Nothing built for the old
scope was wasted — [ADR-0013](adr/0013-the-heartbeat-carries-only-what-placement-scores.md)'s fields are
what a *person* reads when choosing a machine by hand, so the heartbeat's consumer changed and its
payload did not.

```mermaid
flowchart TB
    browser(["browser"]) -->|"GET /api/…"| daemon
    subgraph daemon["yantrad"]
        handlers["handlers<br/>read memory, never await ssh"]
        snap[("snapshot<br/>+ the age of every reading")]
        refresh["background refresh<br/>one poll, many readers"]
        handlers --> snap
        refresh --> snap
    end
    refresh -->|"ssh, on its own schedule"| fleet["the fleet"]
```

**Why the daemon cannot be a thin passthrough** was M4's one design constraint, and it is the shape
every milestone since has kept: `ssh` is configured with `ConnectTimeout=10`, so a machine that is
asleep or holding an expired node key costs **ten seconds**. That is fine for a CLI — a human typed
the command and is watching. It is not fine for a page that polls whether or not anyone is looking,
where one open tab becomes a permanent ssh storm against the whole fleet.

It pays for itself twice: `ControlPersist=300` means any refresh under five minutes keeps every ssh
master warm (**20 ms** against **150 ms** cold), and because the socket path is per-user, a running
daemon makes the **CLI** faster too.

The destination is [`docs/vision.md`](vision.md): ask for a workspace, and the right
machine wakes, the repo opens, tmux restores and the agent resumes — from a phone, a browser, or a
knob on a box on the desk.

---

## Read next

- [`README.md`](../README.md) — install and usage
- [`tracker.md`](../tracker.md) — what is decided, open, and at risk, right now
- [`crates/*/tracker.md`](../crates/) — **the invariants**, filed with the crate each one binds. The
  highest-value thing in the repo: most of them were earned by a bug that presented as something
  else entirely
- [`docs/adr/`](adr/) — the decisions, immutable once accepted
