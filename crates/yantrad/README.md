# yantrad

The Yantra control-plane daemon: machine inventory, workspaces, session state, placement. Every
client — CLI, web UI, hardware panel — talks to this and nothing else.

**Barely implemented.** It serves `/healthz`, a read-only JSON API, and one write. A background
task keeps machines, workspaces and sessions in memory with the age of each reading, so no request
ever waits on ssh. The CLI calls [`yantra-core`](../yantra-core/README.md) in-process and keeps
working with no daemon running — that is a decision, not a gap
([ADR-0012](../../docs/adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md)).

| Route | CLI equivalent |
| --- | --- |
| `GET /api/machines` | `yantra ls machines` |
| `GET /api/workspaces` | `yantra ls workspaces` |
| `GET /api/sessions` | `yantra ls sessions` |
| `POST /heartbeat` | — (`yantra-agent` posts it every 10 s) |

`POST /heartbeat` is the only route that takes a body. It answers **`204` with nothing in it** and
always will — a reply the agent could act on would make the agent something other than a reporter
([ADR-0013](../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md)). The body names
no machine: the beat is attributed to whichever peer holds the address it arrived from, and one from
an address no peer holds is refused with `403`.

Every answer names which of three states it is in, so an empty list is never mistaken for a fault:

```json
{"looked": "ok",     "age_seconds": 6, "data": [ … ]}
{"looked": "failed", "age_seconds": 3, "error": "…"}
{"looked": "never"}
```

Run it with `yantrad`. It listens on **port 7717**, on the addresses Tailscale says this machine
holds, and refuses to start if it cannot learn them. There is no flag to change either — with no
authentication (Q6, personal-first), where it listens is the whole security model.

[tracker.md](tracker.md) collects what research already settled about it — SQLite handling, scheduling
determinism, PTYs — none of it exercised by code yet. See [../../tracker.md](../../tracker.md) for
where this sits in the roadmap.
