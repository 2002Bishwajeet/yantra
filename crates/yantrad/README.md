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
| `POST /api/workspaces` | `yantra new` |
| `POST /api/workspaces/{name}/up` | `yantra up` |
| `POST /api/workspaces/{name}/down` | `yantra down` |
| `POST /api/workspaces/{name}/resume` | `yantra resume` |
| `POST /heartbeat` | — (`yantra-agent` posts it every 10 s) |

The four `POST /api/…` routes are authorised by Tailscale identity
([ADR-0016](../../docs/adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)): the
source address is resolved live, and anything that is not this owner's own untagged node is refused
`403`. A `tailscale` that cannot answer is **`503`** — nothing was decided about the caller, so
blaming them would be a lie about which thing broke.

`POST /heartbeat` answers **`204` with nothing in it** and
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

It speaks **plain HTTP and always will**. TLS belongs to `tailscale serve`, which already holds and
renews a certificate for the machine's `*.ts.net` name — `just https` puts the dashboard on
`https://<machine>.<tailnet>.ts.net:8443/`, which is what a phone needs and what the PWA's secure
context requires. One caveat, measured: a proxied write arrives from the *proxy's* address, so
ADR-0016's identity check sees the machine running the proxy rather than the caller. See its
amendment and [`docs/development.md`](../../docs/development.md).

[tracker.md](tracker.md) collects what research already settled about it — SQLite handling, scheduling
determinism, PTYs — none of it exercised by code yet. See [../../tracker.md](../../tracker.md) for
where this sits in the roadmap.
