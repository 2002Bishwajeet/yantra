# ADR-0048 — One claude-mem server on the box

- **Date:** 2026-11-23
- **Status:** Proposed. The owner accepts it. [Y-821](../../tracker.md) builds it after that.
- **Evidence:** [R22](../research/22-claude-mem-shared-memory.md) §10 (the server runtime, 2026-11-20)
  and §11 (the model test, 2026-11-23).
- **Unchanged:** [ADR-0032](0032-the-appliance-keeps-the-conversation-history-encrypted.md), which
  keeps the conversation history. This ADR is about memory, not transcripts.

## Context

The owner wants one shared memory for every machine and account (Y-820). Today each account runs its
own local claude-mem, so the laptop, the Mac and the `work` account on yantra-box each know
different things.

claude-mem 16 has a server runtime. R22 §10 ran it on the box with no cmem.ai login, and a laptop
session reached it over the tailnet with a key. R22 §10.7 left five points for an ADR. §10 used a
stub model, and the worker needed a metered API key. R22 §11 closes that gap: a custom provider
module that runs `claude -p` with the owner's Claude login generated real observations and a
summary. The model was `claude-haiku-5-5`, and one generation took about 3.5 s.

The server is a new service on the box, with a database, a queue and a credential in its path.
The owner asked for the choice to be made, not handed back.

## Decision

1. **The worker uses the `biswa` Claude login, through a custom provider module.** The module runs
   `claude -p` with model `haiku`. The server selects it with `CLAUDE_MEM_SERVER_PROVIDER=custom`
   and `CLAUDE_MEM_CUSTOM_PROVIDER_MODULE`. There is no paid API key and no fork of claude-mem.
2. **The server and the worker run on the host as `biswa`, not in a container.** The login file
   `~/.claude/.credentials.json` is then never copied. Upstream's image copies it into the
   container, and the two copies refresh apart (R22 §11.1).
3. **Generation concurrency is 2** (`CLAUDE_MEM_SERVER_GENERATION_CONCURRENCY=2`). There are two
   lanes, so at most four `claude` processes run at once. This bounds the share of the owner's
   quota that memory can use.
4. **The module has four duties.** It strips `CLAUDE_MEM_SERVER_DATABASE_URL`,
   `CLAUDE_MEM_REDIS_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and
   `CLAUDE_MEM_ANTHROPIC_API_KEY` from the environment of the CLI. It refuses a helper `apiVersion`
   other than 1. It maps a missing binary (`ENOENT`) to `unrecoverable`. It passes the flags of R22
   §11.2, so the CLI loads no plugin, tool, slash command or saved session. The code is in R22
   §11.2. The worker takes the module path from its environment only, and logs the path and the
   sha256 at start.
5. **Postgres and Valkey run in rootless podman as `biswa`, bound to 127.0.0.1.** The HTTP server
   binds to the box's tailnet address only. No port opens on any other interface.
6. **Each client has its own API key** with scope `memories:read,memories:write`. The key lives on
   its client, in claude-mem's own `~/.claude-mem/settings.json`, mode `0600`. Yantra never holds
   a key, and no Yantra file, workspace or daemon setting names one. §B4 is therefore unchanged:
   the server's keys are not a Yantra daemon secret. A lost client gets its key revoked, and the
   next request returns 403.
7. **Redaction is on in every client before its first session.** Each client sets
   `CLAUDE_MEM_REDACT_ENABLED=true` and the custom pattern of R22 §9.7. One client with the
   default sends raw secrets to Postgres. Y-819 sets this for a new account. An existing client
   gets the same settings from Y-821, and Y-821 checks them.
8. **The fleet shares one project.** The server's bootstrap makes one project, and R22 §10.6 found
   no route that makes a second. Every hook sends its work to that project, whatever the
   repository.
9. **A client drops its events while the box is off.** R22 §10.6 shows the hook logging
   `skipped event` and keeping no file to retry. Each client sets
   `CLAUDE_MEM_WORKER_AUTOSTART=false`, because autostart would fall back to a local worker and
   split the memory between the server and that machine's SQLite. The owner accepts the loss of
   those events and of the summary of a session that ends while the box is off. Search and context
   fail the same way, and the session goes on without memory.
10. **The build is pinned.** The tag is `v16.0.0` until a test passes a newer one. Anything
    containerised builds `FROM node:20-trixie`, because the upstream `node:20` base has glibc 2.36
    and the tree-sitter binary needs 2.39. Postgres builds from upstream's `docker/postgres` with
    `--from docker.io/library/postgres:17-trixie`. Every process sets `CLAUDE_MEM_TELEMETRY=0` and
    `DO_NOT_TRACK=1`, on the box and on every client.
11. **The module and the service units live in the box builder repo, not here.** The module is
    JavaScript, and §B1 keeps JavaScript out of the daemon, the CLI and the agent. This repo holds
    no copy of it. This ADR records only its contract, which is decisions 1 to 4.

## Consequences

**Gained.** One memory for the laptop, the Mac and every account on the box, with a handoff that
needs no copy. No metered key, no stored provider credential and no fork. The listener and the
credential are apart: the worker opens no port.

**Cost: a shared rate limit.** Every observation uses the owner's subscription quota, the same
quota as the owner's own sessions. The concurrency cap bounds the burst and not the total. R22
§11.5 did not test the `rate_limit` mapping. A heavy day of memory work can slow the owner's own
sessions.

**Cost: the box login is now a dependency.** When the login on the box expires, generation fails
with `auth_invalid` and no observation is written. The events stay in the queue. Someone must log
in again on the box. The memory service needs an alert for this.

**Cost: an untested token-refresh race.** The worker's `claude` processes and the owner's own
sessions on the box may refresh the login token at once. R22 §11.5 did not test that race. A lost
race may log the login out.

**Cost: a beta helper API.** The provider interface has `apiVersion` 1 and upstream calls the
server beta. A claude-mem upgrade can break the module. The module refuses a helper version other
than 1, so generation then stops until someone updates it. The pinned tag of decision 10 and a
smoke test before each upgrade are the answer.

**Cost: lost events.** Decision 9 accepts them. A session that runs while the box is off leaves no
memory behind.

**Cost: a service to run.** Two containers, two host processes and one module, on a box that the
owner also uses for other work. The claude-mem image is 3.13 GB, and the server and worker used
about 450 MB idle (R22 §10.2).

**Cost: the worker runs under the owner's account.** A fault in claude-mem runs with the rights of
`biswa`. The stripped environment and the module's flags limit what the CLI sees. They do not make
a sandbox.

**Not changed.** The daemon holds no key and no memory. No new Yantra secret, file or store.

## Alternatives

**A paid API key.** It is simple and it is a supported route. It adds a metered bill, and a key on
the box that §B4 would have to name as a third exception. It also adds nothing that the login does
not give, at this volume.

**A container with a copied credential.** It matches upstream's image and isolates the worker. It
copies the login token, and the copy and the original refresh apart, so one of them goes stale.

**A fork of claude-mem.** It would let the server use the subscription directly. It buys a merge
burden on a project that releases several times a week. The custom provider hook does the job
without a fork.

**A local claude-mem on each account, as today.** It needs nothing new. It fails the owner's ask:
each account keeps a separate memory, and nothing hands context from one machine to another.

## Sources

Accessed 2026-11-23.

- [R22](../research/22-claude-mem-shared-memory.md) §9.7, §10 and §11, which hold the commands, the
  environment, the module code and the timings.
- `thedotmack/claude-mem` at `v16.0.0` (`cc0fb95`): `src/server/runtime/create-server-service.ts`,
  `src/server/generation/providers/*`, `entrypoint.sh`, `docker/postgres`.
