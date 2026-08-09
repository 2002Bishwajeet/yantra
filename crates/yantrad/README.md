# yantrad

The Yantra control-plane daemon: machine inventory, workspaces, session state, placement. Every
client — CLI, web UI, hardware panel — talks to this and nothing else.

It serves `/healthz`, a read-only JSON API, the writes that act, and the dashboard itself. A
background task keeps machines, workspaces and sessions in memory with the age of each reading, so
no *read* ever waits on ssh. The CLI calls [`yantra-core`](../yantra-core/README.md) in-process and
keeps working with no daemon running — that is a decision, not a gap
([ADR-0012](../../docs/adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md)).

Every route below has a CLI equivalent, and that is the rule rather than a coincidence: anything the
web UI can do must be expressible in `yantra` first, which is what stops the daemon growing a richer
API the CLI cannot reach.

| Route | CLI equivalent |
| --- | --- |
| `GET /api/machines` | `yantra ls machines` |
| `GET /api/workspaces` | `yantra ls workspaces` |
| `GET /api/sessions` | `yantra ls sessions` |
| `GET /api/workspaces/{name}/status` | `yantra status <name>` |
| `GET /api/readiness` | `yantra doctor` |
| `GET /api/machines/{name}/readiness` | `yantra doctor <machine>` |
| `POST /api/workspaces` | `yantra new` |
| `PATCH /api/workspaces/{name}` | `yantra edit` |
| `POST /api/workspaces/{name}/up` | `yantra up` |
| `POST /api/workspaces/{name}/down` | `yantra down` |
| `POST /api/workspaces/{name}/resume` | `yantra resume` |
| `POST /heartbeat` | — (`yantra-agent` posts it every 10 s) |

The `/api/…` routes that write are authorised by Tailscale identity
([ADR-0016](../../docs/adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)): the
source address is resolved live, and anything that is not this owner's own untagged node is refused
`403`. A `tailscale` that cannot answer is **`503`** — nothing was decided about the caller, so
blaming them would be a lie about which thing broke.

**Which address that is depends on where the connection came from**
([ADR-0017](../../docs/adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)): when
the TCP peer is one of the daemon's own bind addresses the request was proxied on this machine, so
`X-Forwarded-For` names the caller; otherwise the peer does, and a header sent straight to `7717` is
ignored. A forwarded value that is not exactly one address is a **`503`** — nothing was decided, and
the caller did not write it.

`PATCH /api/workspaces/{name}` rewrites only the fields the body names, and answers the workspace as
it now reads — the same shape `POST /api/workspaces` answers with. `"startup": null` clears the
startup command and an absent `startup` leaves it alone; a body naming no field at all is a `400`.
It is also the one route that **refuses** on purpose: changing `machine` while a tmux session is open
on the machine being left is a **`409`**, because the session would stay behind where `down`,
`resume`, `status` and `logs` no longer look and each would report it as absent. A machine that could
not be asked is a **`503`** rather than a move — an unreachable machine can be holding that session
just as well as a reachable one, so a typo in `machine` is unfixable while its machine is asleep, and
there is no override.

```json
PATCH /api/workspaces/site   {"repo": "/home/<user>/code/site", "startup": null}
```

`up`, `down` and `resume` refuse in the same three shapes, and every error they can carry is named
one at a time (Y-135). A **`409`** is a refusal about state — the world already answers and a person
changes that answer: an agent holding at claude's trust dialog, one that is not logged in, a session
opened as a shell with no conversation to continue, a workspace that runs something of its own, a
`repo` the machine does not have. A **`503`** is nothing decided at all — ssh, tmux, terminfo, a
status that could not be read. A **`500`** is left for what is this daemon's own fault. Before this
every error but a workspace's fell through to `500`, and the dashboard reported a crash where a
human had simply not yet answered a dialog on their own machine.

`POST /heartbeat` answers **`204` with nothing in it** and
always will — a reply the agent could act on would make the agent something other than a reporter
([ADR-0013](../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md)). The body names
no machine: the beat is attributed to whichever peer holds the address it arrived from, and one from
an address no peer holds is refused with `403`.

`GET /api/machines` is where those beats are read back. Each machine carries the latest one and how
long ago it arrived, and a machine nothing has ever been heard from carries **`null`** rather than a
row of zeros — the two send a person to different places. The daemon names no display state: it
serves the age and Tailscale's `online`, and the dashboard turns those into ADR-0013 §7's four. The
beat is the one thing on this route that `yantra ls machines` cannot yet show.

```json
{"name": "cachyos-g14", "online": true, …,
 "heartbeat": {"age_seconds": 1, "arch": "x86_64", "labels": ["gpu", "podman", "tmux"],
               "free_ram_mb": 7866, "free_disk_mb": 361282, "cpu_busy_pct": 8, "power": "ac"}}
```

`GET /api/readiness` is [D2](../../docs/design/02-setup.md) §3.1's checks per machine, swept in the
background like every other read, and `GET /api/machines/{name}/readiness` is one machine of it. The
sweep asks the machines a workspace names, so a machine none of them names is a `404` here even
though `yantra doctor <machine>` would go and ask it.

**`heartbeat` is the one check these routes answer and the terminal cannot.** The library reports it
*unknown* from every caller it has, because the beats are in this process and nothing persists them;
here a beat that arrived is *present* with its age, a machine that has never beaten is *absent*, and
one the tailnet list does not hold stays *unknown* — the beats are keyed on the node id, and a report
names a machine the way a workspace does.

Every answer names which of three states it is in, so an empty list is never mistaken for a fault:

```json
{"looked": "ok",     "age_seconds": 6, "data": [ … ]}
{"looked": "failed", "age_seconds": 3, "error": "…"}
{"looked": "never"}
```

Run it with `yantrad`. It listens on **port 7717**, on the addresses Tailscale says this machine
holds, and refuses to start if it cannot learn them. There is no flag to change either — with no
authentication (Q6, personal-first), where it listens is the whole security model.

`YANTRA_WEB` points it at a directory of built assets. Unset it and the API serves alone and `/`
says how; point it at a directory with no `index.html` and it refuses to start rather than answering
404 to everything, which reads as a broken dashboard instead of a typo in one variable. **A
directory that vanishes after that check is a `503` and a log line**, never a blank page and never an
exit: the API, the heartbeat and the terminal socket are still serving, and only the dashboard's
files are gone.

For the M7 appliance there is a second way, and it is a cargo feature that is **off by default**:
`just appliance-embedded` builds `yantrad --features embed-dashboard`, which compiles `web/dist`
into the binary so a Pi 5 gets one file to copy instead of a binary, a directory and a variable. The
default build is byte-for-byte unaffected and still needs no Node — R-24, and `just no-node` is the
check that keeps it true. **A directory that was named still wins, and a wrong one is still a
refusal**: the copy inside the binary cannot be mistyped and the variable can, so the fallible half
keeps the refusal rather than being quietly papered over by a stale dashboard.

`YANTRA_NTFY_URL` points it at a relay to publish session changes to, and `YANTRA_NTFY_TOKEN`
authenticates against one that is protected. Unset the first and the daemon sends nothing, which is
not an error; the token is read from the environment and from nowhere else — never a workspace field,
never a file, never a log line, never the API. `yantra notify` publishes to the same channel by hand,
which is how a box with no screen proves the topic works. See
[`docs/development.md`](../../docs/development.md).

It speaks **plain HTTP and always will**. TLS belongs to `tailscale serve`, which already holds and
renews a certificate for the machine's `*.ts.net` name — `just https` puts the dashboard on
`https://<machine>.<tailnet>.ts.net:8443/`, which is what a phone needs and what the PWA's secure
context requires. One caveat, measured: a proxied write arrives from the *proxy's* address, so
ADR-0016's identity check sees the machine running the proxy rather than the caller. See its
amendment and [`docs/development.md`](../../docs/development.md).

[tracker.md](tracker.md) collects what research already settled about it — SQLite handling, scheduling
determinism, PTYs — none of it exercised by code yet. See [../../tracker.md](../../tracker.md) for
where this sits in the roadmap.
