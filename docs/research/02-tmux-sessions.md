# 02 — Terminal session persistence & programmatic control (tmux, zellij)

Research note for YANTRA. **[V]** = executed here against `tmux 3.7b` (Linux 7.1.3-2-cachyos, private socket,
2026-07-28). **[D]** = docs only, not executed.

## Summary

- **The idempotent tmux idiom everyone copies is broken for daemons.** `new-session -A -d -s NAME` fails with `open
  terminal failed: not a terminal` when the session exists, because `-A` turns it into `attach-session`, which needs a
  TTY. Use plain `new-session -d`, treating exit 1 + `duplicate session:` as success — atomic under 30-way concurrency.
- **`capture-pane -S -N` does not mean "last N lines"** — it starts N lines above the *visible* pane and captures to
  the bottom (`-S -10` → **50** lines on a 40-row pane). Worse, while a TUI (an AI agent) holds the alternate screen,
  scrollback is **entirely unreachable**. capture-pane is a snapshot tool, not a transcript tool.
- **Control mode (`tmux -CC`) beats polling on every axis, but is not the v1.** Push `%output %<pane>` with
  octal-escaped raw bytes, request/response via `%begin/%end` command numbers, N panes per connection, real flow
  control — at the cost of a decoder and a resize handshake.
- **The PTY belongs on the daemon side, not in the web stack.** A PTY opened as part of spawning the child, with
  no native addon in the browser-facing layer **[D]**, so daemon-side PTY + xterm.js is the
  least-work v1.
- **Reboot survival is Yantra's job.** resurrect/continuum restore layout + cwd + a *whitelist of re-run commands* —
  never process state, on a 15-min lossy timer, via a status-line side channel **[D]**. Yantra's DB is the manifest.

## Findings

### 1. The tmux CLI surface

All **[V]**. `has-session` exits 1 for both "session missing" and "no server running", distinguishable only by stderr
— Yantra must tell them apart. **Targets are prefix-matched** (`-t brandn` matched `brandnew`); `=` forces exact.
**`:` and `.` in a name make a session permanently unaddressable**: tmux *accepts* creating `a:b`, but `-t a:b` splits
on `:` into session `a`/window `b`, and `-t '=a:b'` fails identically — `=` does **not** save you. 3.7 also accepts
spaces, `/`, `$`, `..` and the empty string, so sanitization is entirely Yantra's job. `list-sessions`/`list-panes`
accept `-f` for server-side filtering. `kill-session` on a missing session exits 1 — treat as success.

### 2. Control mode (`tmux -CC`)

Each stdin command yields one block guarded by `%begin <epoch> <cmdnum> <flags>` … `%end` (ok) or `%error` (fail);
`<cmdnum>` correlates response to request, so this is a real request/response protocol, not just a stream. `%output
%<paneid> <data>` is pushed async, `<data>` being the raw byte stream with non-printables escaped as **octal** —
including the backslash (`\033\134` = `ESC \`), so decoding is a `\NNN` → byte pass. **[V]** Also documented **[D]**:
`%sessions-changed`, `%window-add/close/renamed`, `%layout-change`, `%pane-mode-changed`, `%client-detached`,
`%subscription-changed`. `refresh-client -C WxH` sets client size and `-B "name:%pane:#{fmt}"` subscribes to a format
— both parse on 3.7b **only when quoted** (unquoted `#{...}` → `parse error: syntax error`) **[V]**; `-f
pause-after=<s>` gives flow control **[D]**. **A bare empty line on stdin detaches the client** — never let a stray
newline through. **[V]** **Verdict:** strictly better than capture-pane polling — push vs poll, exact bytes vs
reconstructed grid, works with the alternate screen, one connection for N panes, real flow control — but not the
shortest path to v1. Adopt in v2 when concurrent live panes per machine become the bottleneck.

### 3. Streaming a live terminal to the browser

| | (a) daemon PTY + xterm.js/WS | (b) ttyd per machine | (c) control-mode relay |
|---|---|---|---|
| Work for v1 / per-machine install | **lowest** / none (ssh only) | low but ops-heavy / binary + service + auth everywhere | highest / none |
| Auth | Yantra owns end-to-end | delegate `--auth-header` / Tailscale ACL | Yantra owns |
| Scaling | 1 PTY + 1 ssh per viewer | 1 process per viewer per box | **1 conn/machine, N panes** |

**(a) is the v1**: spawn a PTY running `ssh -tt <host> tmux -u attach -t "=<name>"`, pipe bytes both ways over a
WebSocket into xterm.js, forward resize. The PTY needs `write()`, `resize()`, raw mode and `close()`, and must be
created **with** the child rather than before it or `^C` will not work — see I-18 and [06](06-runtime-feasibility.md)
**[D]**. Do **not** plan on `node-pty` (native NAN/N-API addon, N-API port still an open PR)
**[D]**. **(b) is a trap here** — a daemon, port and auth boundary on every machine, and Yantra ends up proxying
WebSockets it cannot inspect; emergency fallback only. **(c) scales best**: one connection per machine multiplexes
every pane and yields structured events instead of scraping. **Honest caveat on (a):** one PTY per *viewer* means two
browser tabs = two tmux clients, so the smaller clamps pane size. Set `window-size latest` / `aggressive-resize`,
accept it, or go to (c).

> **2026-08-04 (Y-131): the caveat is real and its mechanism is not the one written above.** `window-size` already
> defaults to `latest` and `aggressive-resize` to `off`, so the suggested settings were never absent. And **nothing
> clamps to the smaller client**: with two live clients on one window, measured through `pty::Terminal` against a real
> tmux, a **larger** latecomer takes the window exactly as a smaller one does. `latest` means the client used *last* —
> attaching takes the window, and then a single keystroke on any other client takes it back while both are still
> attached, so the size follows whoever is typing. Its cost is bounded and reversible: the pane reflows to the narrow
> client and reflows back when that client leaves, with the text intact, and a window with one client left returns to
> that client's size untouched. So the choice the table offers is not between three mitigations — it is *accept*, and
> Yantra sets no tmux option for this. Recorded as **I-54**; the alternative `window-size manual` was measured too and
> stops the *only* client resizing its own window, which is why it was rejected. Verified on tmux **3.5a** (the CI
> fixture) and **3.7b** (`cachyos-g14`), step for step identical. `aggressive-resize` was not measured — it governs a
> window smaller than the session, which is not this.

### 4. Surviving a reboot

tmux sessions are children of the `tmux server`; reboot kills it and everything in it. All **[D]**: **tmux-resurrect**
saves/restores sessions, windows, panes and order, per-pane cwd, exact layouts (incl. zoom), active/alternative
session & window, focused pane per window, grouped sessions, and optionally pane contents and vim/neovim sessions. But
**"restores running programs" is a lie of omission** — no process is checkpointed; it records the command line of
programs matching a whitelist (default `vi vim nvim emacs man less more tail top htop irssi weechat mutt`) and
**re-runs them**. Extend via `@resurrect-processes` (`~` substring, `->` display rename, `* ` keep args); `:all:`
restores everything and the docs explicitly warn it can re-run destructive commands. **tmux-continuum** adds autosave
every **15 min**, auto-restore **only on tmux server start** (`@continuum-restore on`; sourcing the config does
nothing) and optional boot start — but it depends on resurrect *and* on the status line, so a theme overwriting
`status-right` silently disables autosave, and it must be last in the plugin list. **Verdict: do not build on
resurrect/continuum** — a 15-min lossy snapshot, a fragile status-line side channel, a process whitelist and
per-machine plugin installs are all things Yantra answers better. Instead, per workspace persist `{workspaceId, host,
sessionName, cwd, windows[], per-pane command spec, env}`; on daemon start or `open`, reconcile desired-vs-actual per
host via `list-sessions -F`; recreate missing sessions with `new-session -d` + explicit `new-window`/`send-keys`; and
mark long-running agent panes `needs-manual-resume` rather than blindly re-running an agent that may have been
mid-edit.

### 5. Naming & idempotency

`yantra-<slug>-<hash8>` with `slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,24)` and `hash8 =
sha256(workspaceId).hex.slice(0,8)`. Forced by §1: charset `[A-Za-z0-9_-]` only; the prefix + hash defeats
prefix-match collisions and enables `-f '#{m:yantra-*,...}'` enumeration; hash is identity, slug is decoration.
**Always address as `-t "=$NAME"`.** Open is made idempotent by running plain `new-session -d` unconditionally and
treating exit 1 + stderr `duplicate session:` as success — a single atomic server-side op, **[V]** under 30 concurrent
invocations (exactly 1 session; 1 × exit 0, 29 × duplicate). **Do not** use `has-session || new-session` (TOCTOU), and
**do not** use `new-session -A -d`: `-A` makes it behave as `attach-session`, which needs a TTY, so it dies with `open
terminal failed: not a terminal` from a daemon whenever the session already exists. **[V]**

### 6. Is the pane alive / busy / crashed?

`#{pane_current_command}` is the foreground process of the pane's tty (`sleep 30` → `sleep`, idle → `bash`) **[V]** —
cheap, good for "busy?", weak for "which agent?" since wrappers all report `node`/`python`. `#{pane_pid}` is **the
shell, not the agent**: `pane_pid=90323` was bash while the actual `sleep` was child PID `90345` **[V]**, so walk its
children. **Exit codes require opting in** — by default an exiting pane is destroyed and its status lost; with
`remain-on-exit on`, `#{pane_dead}`/`#{pane_dead_status}` become readable (`sh -c 'exit 42'` → `dead=1 status=42`)
**[V]**. Set it on every agent session or Yantra can never distinguish "finished" from "crashed". `wait-for` works
(blocked 0.506 s vs a 0.5 s signaller **[V]**) but channels are a flat global namespace and **a signal sent before
anyone waits is not queued** — the waiter hangs forever, so always add a timeout. Composite rule: `alive = !pane_dead
&& pane_current_command != shell`; `crashed = pane_dead && pane_dead_status != 0`; `finished = pane_dead &&
pane_dead_status == 0`; plus a sentinel-marker fallback for agents that exit into their own REPL.

### 7. Durable scrollback / logs

`pipe-pane` is right, with two real gotchas **[V]**. **`-o` is a toggle, not an idempotency guard**: the manpage's
"only opens a new pipe if no previous pipe exists" reads like idempotent-on, but a second `pipe-pane -o` while a pipe
is active **turns logging off** (a following `echo SECOND` produced 0 matches), while omitting `-o` **duplicates**
(`echo THIRD` landed 2×) — so gate on `#{pane_pipe}` and never blind-retry. And **the stream is raw and enormous**: it
is what the terminal would render, carrying typed input echo, full SGR/CSI, OSC title sets, bracketed-paste toggles
and shell-integration OSC — two trivial `echo`s = **966 bytes**, and an agent redrawing a TUI produces MB/min. Prefer
`pipe-pane -O -t X 'yantra-logsink --pane %1'` over `cat >>` so ANSI-stripping, timestamping and capping happen
inline. `capture-pane` polling fails as the primary mechanism because (a) `-S -N` is not "last N lines", (b) with a
TUI on the alternate screen a `-S -` capture returned **only** the alt screen, pre-TUI scrollback reachable solely via
`capture-pane -a` (the *saved normal* screen) **[V]**, and (c) `-e` does not replay original bytes — it re-synthesizes
SGR from the cell grid, so `\033[1;31m` came back as `\033[1m\033[31m` **[V]**. Snapshots → capture-pane; the log →
pipe-pane. Default `history-limit` is **2000** lines **[V]**; raise it on Yantra-managed servers.

### 8. zellij

Not installed here; all **[D]**. Equivalents: `zellij list-sessions`, `zellij attach --create-background <name>` (true
headless create, no TTY), `zellij run -- <cmd>`, `zellij --session <n> action <verb>`. Genuinely **better than tmux**:
`action list-panes --json` / `list-tabs --json` return structured JSON with `exited`, `exit_status`, `pane_command`,
`pane_cwd` and geometry — no format DSL, no parsing; `zellij subscribe --pane-id <id> --format json` is an **NDJSON
stream** of `pane_update` (`viewport[]`/`scrollback[]`) and `pane_closed` events, which tmux has no equivalent for;
`new-pane --block-until-exit-success` gives synchronous job semantics without the `wait-for` dance; creating commands
return the new id on stdout; and `dump-screen`/`subscribe` **strip ANSI by default** (`--ansi` to keep) — the opposite
default from tmux, and the right one for log ingestion. Loses on: much smaller install base, no `-CC` equivalent for
byte-exact interactive relay, same reboot problem. **Verdict: defer** — tmux is what is actually installed, every
capability above has a workable tmux path, and two multiplexers on day 1 doubles the surface of the least-interesting
layer. Keep JSON-shaped return types that zellij would naturally produce, and add a driver when a machine runs it.

## What Yantra reuses

tmux as the persistence primitive (already everywhere, no new per-machine daemon) · `new-session -d` atomicity as the
concurrency control for "open workspace" · `remain-on-exit` + `pane_dead_status` for exit codes · `pipe-pane` for
durable transcripts · a daemon-side PTY spawned with its child · xterm.js · ssh over
Tailscale as transport · tmux control mode later as the v2 streaming transport.

## What Yantra must build itself

- **Workspace manifest + reconciler** — DB is truth, tmux is cache; reboot recovery, "continue workspace" and drift
  detection all fall out of one reconcile loop.
- **Name derivation, `=`-exact addressing, charset sanitizer** (§5), and a **tmux client wrapper modelling the real
  error surface** — no-server vs no-session, `duplicate session:` as success, prefix-match avoidance.
- **A log sink** on the `pipe-pane` consumer side: ANSI strip, timestamp, rotate, size cap.
- **Agent liveness heuristics**: child-process walk from `pane_pid` + a sentinel protocol the agent wrapper emits,
  since `pane_current_command` cannot tell `node` from `node`.
- **PTY↔WebSocket bridge** with resize forwarding and reconnect/replay-last-N-bytes, behind a **Multiplexer interface**
  so zellij can be added without a rewrite.

## Risks & unknowns

- The PTY layer is **[D]**-only here — nothing was run. Verify the controlling-terminal behaviour (I-18) before
  committing to (a); fallback is `ssh -tt` + plain pipes (loses proper TTY signalling).
- tmux versions differ across machines — `refresh-client -B` and some format vars are recent. Probe `#{version}` and
  degrade rather than assume 3.7. Multi-viewer pane sizing (§3) is unresolved and immediately user-visible.
- `wait-for` signals are not queued — one firing before the waiter attaches hangs it forever. `pipe-pane` volume from
  agent TUIs is unbounded; hard cap from day 1.
- zellij findings unverified — don't quote its JSON shapes into code without running it. `%output` escaping verified
  for octal + backslash, not UTF-8 multi-byte; test CJK/emoji before (c).

## Concrete reference

All **[V]** on tmux 3.7b. `N` = session name; always address as `-t "=$N"`.

```bash
T="tmux -S /run/yantra/tmux.sock"
$T has-session -t "=$N"          # 0 = exists; 1 = missing OR no server
# no server -> stderr: error connecting to /run/yantra/tmux.sock (No such file or directory)
# missing   -> stderr: can't find session: NAME
# --- create (race-free, idempotent) ------------------------------------------
$T new-session -d -s "$N" -c "$DIR" -x 200 -y 50 -P -F '#{session_id}'
#   exit 0 -> stdout: $3
#   exit 1 + stderr "duplicate session: NAME" -> already exists, SUCCESS
# DO NOT USE: new-session -A -d  -> "open terminal failed: not a terminal" when it exists
$T list-sessions -F '#{session_name}|#{session_id}|#{session_created}|#{session_attached}|#{session_windows}|#{session_path}|#{session_activity}' \
   -f '#{m:yantra-*,#{session_name}}'
# ws-abc123|$0|1785263204|0|1|/home/<user>|1785263204
# (no -F:)  ws-abc123: 1 windows (created Tue Jul 28 20:26:44 2026)
$T list-panes -a -F '#{session_name}|#{window_index}|#{pane_index}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}|#{pane_dead}|#{pane_dead_status}|#{pane_width}x#{pane_height}|#{pane_pipe}'
# ws-abc123|0|0|%0|86679|bash|/home/<user>|0||80x24|0
$T display-message -p -t "=$N" '#{session_name} #{session_created} #{pane_pid} #{history_size} #{history_limit} #{alternate_on}'
# ws-abc123 1785263204 86679 68 2000 0
$T display-message -p '#{version} #{pid} #{socket_path}'      # 3.7b 86832 /tmp/ytr.sock
$T send-keys -t "=$N" 'echo hi' Enter        # key-name lookup ON ("Enter" is a key)
$T send-keys -t "=$N" -l 'literal text'      # -l = no lookup, raw UTF-8
$T capture-pane -p    -t "=$N"    # visible pane only, trailing spaces stripped
$T capture-pane -p -N -t "=$N"    # -N keeps them:  "line-62<28 spaces>"
$T capture-pane -p -e -t "=$N"    # SGR included but RE-SYNTHESIZED:
                                  #   printf '\033[1;31m' returns as ^[[1m^[[31m
$T capture-pane -p -e -C -t "=$N" # -C escapes non-printables as literal \033
$T capture-pane -p -S -  -t "=$N" # entire scrollback + visible  (108 lines here)
$T capture-pane -p -S -10 -t "=$N"
      # !! 10 history lines PLUS the whole visible pane -> 50 lines on a 40-row pane, NOT 10
$T capture-pane -p -a -t "=$N"    # the SAVED NORMAL screen while a TUI holds alt-screen
# while #{alternate_on}==1: -S - returns ONLY the alt screen; scrollback is unreachable
# --- durable log -------------------------------------------------------------
[ "$($T display-message -p -t "=$N" '#{pane_pipe}')" = 0 ] && \
  $T pipe-pane -t "=$N" 'yantra-logsink --pane %1'
# `-o` twice => TOGGLES LOGGING OFF.  no `-o` twice => DUPLICATE lines.
# stream is raw: input echo + CSI + OSC.  two echoes == 966 bytes.
# --- exit codes (must opt in!) -----------------------------------------------
$T set-option -t "=$N" remain-on-exit on
$T list-panes -t "=$N" -F 'dead=#{pane_dead} status=#{pane_dead_status}'   # dead=1 status=42
# --- job completion without polling ------------------------------------------
$T send-keys -t "=$N" "make build; tmux wait-for -S yt-$JOB" Enter
timeout 3600 $T wait-for "yt-$JOB"     # blocks; measured 0.506s vs a 0.5s signaller
$T kill-session -t "=$N"               # 1 + "can't find session: N" if already gone
```

Control mode — `tmux -S "$S" -CC attach -t "=$N"`; stdin takes commands one per line, **blank line detaches**:

```
%begin <epoch> <cmdnum> <flags>    # flags=0 for the initial block, 1 thereafter
<command output lines...>
%end <epoch> <cmdnum> <flags>      # or %error ... on failure
%session-changed $1 pipetest
%output %1 echo CTRLMODE\015\012\033[?2004l\015     # \NNN octal; backslash itself is \134
%exit

refresh-client -C 200x50                            # set this client's size
refresh-client -B "yt:%1:#{pane_current_command}"   # QUOTES REQUIRED; unquoted -> parse error
refresh-client -f pause-after=5                     # flow control  [D]
```

Name derivation (see §5): `"yantra-" + slug(name).slice(0,24) + "-" + sha256(id).hex.slice(0,8)`, slug = lowercase,
`[^a-z0-9] -> "-"`, collapsed and trimmed — **never** allowing `:` or `.`; address always as `-t "=" + sessionName`.

## Sources

All accessed 2026-07-28.

- tmux: https://man.openbsd.org/tmux.1 · https://github.com/tmux/tmux/wiki/Control-Mode ·
  https://github.com/orgs/tmux/discussions/4016
- resurrect/continuum: https://github.com/tmux-plugins/tmux-resurrect ·
  https://github.com/tmux-plugins/tmux-resurrect/blob/master/docs/restoring_programs.md ·
  https://github.com/tmux-plugins/tmux-continuum
- node-pty: https://github.com/microsoft/node-pty/pull/644 · https://github.com/microsoft/node-pty/issues/748
- zellij: https://zellij.dev/documentation/programmatic-control.html · https://zellij.dev/documentation/cli-actions ·
  https://zellij.dev/news/remote-sessions-windows-cli/
- ttyd: https://github.com/tsl0922/ttyd/blob/main/man/ttyd.man.md
