# R21 — T3 Code with T3 Connect, against Yantra

**Asked 2026-10-07 by the owner (Y-445).** The owner keeps building Yantra and credits T3 Code
wherever it is due. This note compares the two feature by feature, so that the next decisions go
where Yantra can be better. It extends [R15](15-t3code-for-the-chat.md) and
[R19](19-acp-for-every-harness.md). It supersedes neither.

- **Read against:** the root [README](../../README.md), [architecture.md](../architecture.md),
  [ADR-0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md),
  [ADR-0032](../adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md),
  [ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md) and
  [`tracker.md`](../../tracker.md) on `main` at `ad8318c`.
- **What was read:** `pingdotgg/t3code` at commit
  [`72d5c32`](https://github.com/pingdotgg/t3code/tree/72d5c32ba67953805feb6fe9ad3b70b632a64c47)
  (2026-10-06 23:53 UTC), server package version `0.0.45`, newest tag
  `v0.0.46-nightly.20261006.2735`. MIT, 25,888 stars, 6,683 forks on 2026-10-07.
- **Every claim says one of:** *code* (read in T3 Code's source at that commit), *docs* (read in its
  `docs/` only), or *Yantra* (read in this repository). Nothing in this note was run. T3 Code ships a
  nightly every day, so re-read anything here before you build on it.
- Below, a T3 path such as `docs/user/remote-access.md` is relative to the T3 Code repository at
  `72d5c32`. A Yantra path is a link.

## Result

**T3 Code is ahead of Yantra on almost every user-facing feature, and the earlier session's summary
of it was wrong.** It is not single-machine and it does have a phone app. It ships an iOS app (the
App Store page answers), web, desktop and a `t3` CLI with `t3 service install`. A phone reaches a
machine directly over LAN, Tailscale or SSH with no account, or through T3 Connect. T3 Connect is a
hosted relay on Cloudflare: it links machines to a Clerk account, gives each machine a Cloudflare
tunnel hostname, and sends push notifications and Live Activities. The relay is not in the data
path, but Cloudflare's tunnel is. T3 Code even has a placement feature (auto balance by CPU and
memory) and a cross-provider delegation MCP server. **Where Yantra differs is structural, not
feature count:** Yantra installs nothing of its own on a machine and keeps every agent in tmux, so a
person can take any session over from any terminal, and a server restart does not end the agent.
T3 Code runs agents as child processes of its own Node server on each machine, so `t3 update` and
a server restart interrupt running turns and terminals, and there is no terminal to attach to. Yantra
also has no cloud account and no third-party edge in any path. Those are the claims Yantra can
defend. Everything else in the table below is a gap to close or a decision to make.

## 1. Feature by feature

| Feature | T3 Code (at `72d5c32`) | Yantra today (`main`, `ad8318c`) | Evidence |
| --- | --- | --- | --- |
| Clients | iOS app (on the App Store), Android app (README links Google Play), hosted web at `app.t3.codes`, Electron desktop, `t3` CLI. `apps/mobile/README.md` still says "not distributed yet", so the docs disagree with the store. | One PWA dashboard served by `yantrad`, installable on a phone. The `yantra` CLI. No native app. | T3 docs: `README.md`, `apps/mobile/README.md`. Store page fetched 2026-10-07. Yantra: [web/README.md](../../web/README.md) |
| What runs on each machine | The T3 server (Node) on every machine, as `t3 serve` or a systemd user service / launchd agent. Desktop SSH mode downloads the server to `~/.t3/runtime` on the far host. | Nothing of Yantra's own is required: `sshd` or Tailscale SSH, `tmux`, `git`, and the agent CLI. `yantra-agent` is an optional heartbeat. `yantra install <machine>` puts tmux, git and claude on a bare machine. | T3 docs: `docs/user/background-service.md`, `docs/user/remote-access.md` § Desktop-managed SSH. Yantra: [README](../../README.md) § Install, [ADR-0028](../adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md) |
| How agents run | In-process adapters in the server. Claude through `@anthropic-ai/claude-agent-sdk`, Cursor through `@cursor/sdk`, Codex through its app-server, OpenCode through its SDK and server, Pi over RPC, the rest over ACP. Terminals are `node-pty` PTYs owned by the server. No `tmux` appears in `apps/` or `packages/`. | Claude Code runs as a TUI in tmux on the machine ([ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md)). The Chat tab runs one `claude -p` per turn over ssh beside it ([ADR-0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md)). Other harnesses speak ACP over ssh ([ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md)). | T3 code: `apps/server/package.json`, `apps/server/src/orchestration-v2/Adapters/`, `apps/server/src/terminal/NodePtyAdapter.ts`; `grep -rl tmux apps packages` is empty |
| Attach to the same agent from a terminal | No. The agent is a child of the T3 server and has no TTY. A person can add T3's MCP server to an outside agent, which then drives T3 threads, but that is not the same session. | Yes. `yantra up` attaches, and `ssh` plus `tmux attach` reaches the same pane from any machine. | T3 docs: `docs/user/remote-access.md` § Connect an outside agent. Yantra: [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md) |
| Phone reaches a machine without a cloud account | Yes. Pair over LAN or a tailnet with `t3 serve --host <ip>` or `t3 pair`, with Tailscale HTTPS via `t3 serve --tailscale-serve`, or with desktop-managed SSH. A pairing link carries a one-time secret in its URL fragment. | Yes, and it is the only way. The phone joins the tailnet and opens the dashboard over HTTPS from `tailscale serve`. | T3 docs: `docs/user/remote-access.md`, `docs/internals/remote.md` § Hosted web is a client. Yantra: [architecture.md](../architecture.md) §3 |
| Phone reaches a machine through a relay | Yes, T3 Connect. `t3 connect` signs in with Clerk (device grant over SSH), links the environment, and provisions a Cloudflare tunnel with a hostname under the relay's tunnel zone. | No relay. | T3 docs: `docs/internals/t3-connect.md`, `infra/relay/README.md` |
| Is the relay required | No for remote access. Yes for push notifications: "a direct or Tailscale connection alone does not enable push notifications." | — | T3 docs: `docs/user/mobile-notifications.md` |
| What passes the relay | The relay Worker brokers links and mints one-time bootstrap credentials bound to the client's DPoP key; it never sees the session token. App HTTP and WebSocket traffic goes over the **Cloudflare tunnel hostname**, not through the Worker. Webhooks are forwarded through the relay, and held in a Durable Object only if the environment opts in. | — | T3 docs: `docs/internals/t3-connect.md` § The relay is a trusted broker. Code: `infra/relay/src/hooks/HookForwarder.ts` |
| What the cloud account holds | Environment links and managed tunnel allocations (PlanetScale), mobile device push tokens, and the agent activity state: project title, thread title, model, phase, a fixed headline, and a detail capped at 160 characters. A failed run's detail is replaced with a fixed string. No prompt or response text is in that schema. | Nothing. There is no account. | T3 code: `packages/contracts/src/relay.ts` (`RelayAgentActivityState`), `packages/shared/src/agentAwareness.ts`, `apps/server/src/relay/AgentAwarenessRelay.ts` |
| Self-host the relay | Possible, not packaged. It is an Alchemy stack on Cloudflare Workers, Queues and Durable Objects, PlanetScale, Clerk, Axiom, APNs and FCM. Clients embed `T3CODE_RELAY_URL` and the Clerk key at build time, so a self-hosted relay needs rebuilt clients. The store apps point at T3's relay. | Not applicable. Push goes to an ntfy URL the owner chooses, and ntfy can be self-hosted. | T3 docs: `infra/relay/README.md` § Deployment, `docs/operations/connect-setup.md`. Code: `apps/server/src/cloud/publicConfig.ts`. Yantra: [ADR-0021](../adr/0021-the-relay-is-written-to-an-environment-file.md) |
| Several machines | Each machine is an "environment" with a stable ID and an ordered list of routes (LAN, Tailscale, public URL, SSH, T3 Connect). The client learns LAN and tailnet addresses and fails over between routes. Thread search in the command palette spans connected environments. | Machines come from `tailscale status` and ssh names. The dashboard lists every machine and every tmux session on the fleet, including sessions no workspace names. | T3 docs: `docs/user/remote-access.md` § Reach one machine several ways, `docs/internals/remote.md`. Code: `packages/client-runtime/src/connection/driver.ts`. Yantra: M2, M12 in [`tracker.md`](../../tracker.md) |
| Placement | **Yes.** "Auto balance" picks a machine for a new thread. The score is weight × CPU count × idle CPU × free memory, from a 15-second-fresh resource sample. It is off by default and computed in the client. | No. M10 is deferred. Today a person picks the machine. | T3 code: `packages/client-runtime/src/load-balancing.ts`. T3 docs: `docs/user/remote-access.md` § Balance new threads. Yantra: M10 in [`tracker.md`](../../tracker.md) |
| A client disconnects | The agent continues on the server. | The tmux session continues. A Chat turn continues while the browser is away, because the ssh link runs from the appliance. | T3 docs: `docs/internals/overview.md`. Yantra: [ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 7 |
| The server restarts or updates | Running turns, terminals and remote clients are interrupted. Threads, history and provider session handles are durable, so the next message resumes the native session. Terminal scrollback is restored; the shell is not. | `yantrad` restarts and the tmux sessions live on; a podman test proves it (Y-368). A Chat turn or an ACP turn in flight dies with its ssh pipe. | T3 docs: `docs/user/background-service.md`, `docs/orchestration-v2/feature-lifecycles.md` § Resumption, `docs/internals/terminal-runtime.md`. Yantra: Y-368, [ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 7 |
| The laptop sleeps | The agent on it stops. T3 Connect reclaims the idle tunnel after about five minutes and makes a new one on wake, at the same hostname. | The agent on it stops. `yantra-agent`'s heartbeat makes the sleep visible on the dashboard. | T3 docs: `docs/internals/t3-connect.md` § Idle tunnels. Yantra: [architecture.md](../architecture.md) §1 |
| Agents supported | Claude Code, Codex, Cursor, Grok Build, OpenCode (1.x and 2.x), Pi, Antigravity, Devin, any ACP Registry agent, and any local ACP command. Several accounts per provider. | Claude Code in tmux and the Chat. Codex, Gemini, Grok and opencode over ACP in `yantra-core` (Y-433), used today by delegation. The Chat does not show them yet (Y-434). | T3: `README.md`, `docs/user/providers-acp.md`, `docs/internals/providers.md`. Yantra: Y-433, Y-434 |
| Approvals | Four modes per thread: Supervised, Auto-accept edits, Auto, Full access. The default for new threads is Full access. | A permission card in the Chat answers `claude`'s `control_request` on stdin. | T3 docs: `docs/user/permission-modes.md`. Yantra: [R20](20-claude-stream-json-turn.md) |
| Worktrees | A thread can start in a new worktree. Location, branch naming, submodules and automatic cleanup are settings. | Each Chat session runs in its own worktree (Y-359). Each delegated task runs in its own worktree (ADR-0033 decision 4). | T3 docs: `docs/user/thread-sidebar.md`, `docs/user/project-settings.md`. Yantra: Y-359 |
| Diffs and checkpoints | Checkpoints on hidden git refs after each turn, a per-turn diff, and revert of files and conversation where the provider allows it. | A delegated task returns a diff summary. No checkpoint, no revert. | T3 docs: `docs/internals/overview.md` § Turn completion and checkpoints. Code: `apps/server/src/checkpointing/CheckpointStore.ts`. Yantra: [ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 5 |
| Git hosting and PRs | Clone, publish, commit, push and create PRs with generated messages. Review, comment, merge, auto-merge. Several PRs linked to one thread, PR stacks, `watch_pull_request`. GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps. | Reads GitHub issues and PRs that wait on the owner (M11), with the daemon's own OAuth grant. No PR is created or merged from Yantra. | T3 docs: `docs/user/source-control.md`. Yantra: [ADR-0023](../adr/0023-the-github-grant-lives-beside-the-relay.md) |
| Notifications | iOS and Android push through APNs and FCM, and iOS Live Activities / Android ongoing cards, on finish, failure, approval and question. Needs T3 Connect. | ntfy push from the daemon on session changes, silent while a tab is open, remembered as events (ADR-0025). Works with no account. | T3 docs: `docs/user/mobile-notifications.md`. Yantra: [`notify.rs`](../../crates/yantrad/src/notify.rs) |
| Voice | Dictation into the composer, transcribed **on the iPhone**. No server transcription. | The phone's or laptop's microphone reaches the machine as a virtual source, so Claude Code's own dictation and any program hear it (ADR-0031, Linux today). | T3 docs: `docs/internals/voice-input.md`. Yantra: Y-417, Y-418, Y-419 |
| Images and files in a message | Paste or drag images, up to 100 files per message, large pastes become attachments. Mobile included. | Not yet (Y-424). | T3 docs: `docs/user/composer.md`. Yantra: Y-424 |
| History and search across devices | Every thread lives in the server's event log and every client reads it. Search spans the connected environments. History on a machine that is off is not reachable. | Transcripts stay on each machine. The encrypted archive on the appliance is decided (ADR-0032) and redaction ships (Y-430). Sync, search and cross-machine resume are not built (Y-431, Y-432). | T3 docs: `docs/user/thread-sidebar.md` § Find and reference work. Yantra: [ADR-0032](../adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md) |
| Delegation | An orchestrator MCP server at `/mcp`. An agent starts a sub-agent on any provider, waits, cancels, steers and reads any thread. Scope is one environment. | `yantra mcp` starts a task on **any machine** and harness, in its own worktree, and returns the last message and a diff summary (Y-435). | T3 docs: `docs/orchestration-v2/orchestrator-mcp-server.md`. Yantra: [ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md) |
| Auth on the machine | Each environment issues its own scoped sessions: pairing links, bearer, DPoP, cookies. Every RPC declares a required scope. Outside agents get OAuth with a permission ceiling. | Reads are open on the tailnet. Writes and the terminal need the tailnet owner by `tailscale whois` (ADR-0016). | T3 docs: `docs/internals/environment-auth.md`. Code: `apps/server/src/auth/RpcAuthorization.ts`. Yantra: [architecture.md](../architecture.md) §3 |
| Data that leaves the machines | Product events to PostHog **by default** (provider, model, mode, result, duration, token totals; no prompt or file content). Opt out with `T3CODE_TELEMETRY_ENABLED=false`. With Connect: the activity fields above to the relay, Apple and Google; app traffic through Cloudflare's edge. | Notifications to the owner's ntfy, GitHub API calls. No telemetry. | T3 docs: `docs/user/telemetry.md`. Yantra: [architecture.md](../architecture.md) §3 |
| Extras with no Yantra equivalent | Browser tabs on the host shared by user and agent, iOS Simulator and Android Emulator panels, HTML renders, scheduled tasks and webhooks, usage limits with "Resume at reset", provider auto-update. | — | T3 docs: `docs/user/remote-access.md` § Browser, `docs/user/devices.md`, `docs/user/thread-sidebar.md`. Code: `apps/server/src/scheduledTasks/` |
| Hardware | None. | M8 hardware is planned: display, encoder, LEDs. | Yantra: M8 |

## 2. Where T3 Code is ahead

Said plainly, because the owner asked for it and because the earlier summary got it wrong.

1. **The phone.** T3 Code has a native iOS app with push and Live Activities. Yantra has a PWA that
   needs Tailscale on the phone and an ntfy app beside it. A person who does not run a tailnet
   cannot use Yantra from a phone at all. T3 Code works for that person.
2. **Reach without a VPN.** T3 Connect gives every machine an HTTPS hostname with no router change
   and no tailnet. The client also fails over between LAN, tailnet, SSH and Connect routes on its
   own, and moves back to the fastest one every minute. Yantra has one route.
3. **Agents.** T3 Code drives eight named harnesses and the whole ACP Registry, each with several
   accounts. Yantra's Chat drives one; the other four are behind delegation only.
4. **The coding loop.** Checkpoints, per-turn diffs, revert, image and file attachments, PR
   creation and review on six hosts, linked PRs and PR stacks. Yantra has none of these in the
   Chat today.
5. **Placement exists there.** T3 Code has the simple version of M10 already: a client-side score
   over CPU and memory, off by default, with a per-machine weight.
6. **Scale of work.** T3 Code has 25,888 stars, a release every day, and a company behind it.
   Yantra will not win on feature count, and it should not try.

## 3. Where Yantra differs or can be better

Only claims this note can support.

1. **The agent outlives the control plane.** T3 Code's agent is a child of its server, and its own
   docs say a restart or `t3 update` interrupts running turns and terminals
   (`docs/user/background-service.md`). Yantra's agent lives in tmux on the machine, and Y-368
   proves a session survives a `yantrad` restart. This is the strongest difference. It holds for
   the TUI session, **not** for a Chat or ACP turn in flight, which dies with its ssh pipe
   (ADR-0033 decision 7). Closing that gap is the "keeper" in R19 §6.
2. **The terminal and the chat are one agent.** In Yantra a person can attach to the same Claude
   Code from any terminal and take it over. T3 Code has no terminal path into its agent.
3. **Nothing of Yantra's runs on a machine.** T3 Code installs a Node server on every machine and
   keeps it running as a user service. Yantra needs ssh and tmux. A machine Yantra has never seen
   is one `yantra install` away, with no daemon left behind.
4. **No account and no third-party edge.** T3 Connect puts Clerk, Cloudflare, PlanetScale, Apple
   and Google in the path, and its own doc says a compromised relay signing key is not harmless
   (`docs/internals/t3-connect.md`). T3 Code also sends PostHog events by default. Yantra's paths
   are the tailnet, the owner's ntfy and GitHub. The cost is item 1 and 2 of §2.
5. **Delegation crosses machines.** T3 Code's orchestrator MCP works inside one environment.
   `yantra mcp` starts a task on any machine in the fleet, in a fresh worktree there.
6. **The microphone reaches the machine.** T3 Code transcribes on the phone and sends text. Yantra
   sends audio to a virtual source on the machine, so the agent's own voice mode and any program
   hear it.
7. **History survives a machine that is off or wiped.** T3 Code's history lives on each server.
   ADR-0032 keeps a redacted, encrypted copy on the appliance. This is decided, not built: it
   becomes an advantage only when Y-431 and Y-432 ship.
8. **Claude runs with its real binary and the machine's own login.** T3 Code drives Claude through
   the Agent SDK. R19 negative finding 5 records that Anthropic's Agent SDK page limits claude.ai
   login in third-party products. Yantra's `claude -p` bridge does not depend on the SDK. This is a
   policy risk for T3 Code, not a feature for Yantra, and it may change.

## 4. What to copy, with credit

T3 Code is MIT, `Copyright (c) 2026 T3 Tools Inc.`. Per ADR-0026 decision 5, a file whose shape
derives from theirs opens with a block comment naming the upstream path and the licence, and
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) grows a line for it. No name, wordmark or
icon. Each item below is a candidate, not a decision. Item 3 needs an ADR.

| What | T3 Code path | Why it fits Yantra |
| --- | --- | --- |
| Agent activity phases and their fixed headlines | `packages/shared/src/agentAwareness.ts` | Six phases (`starting`, `running`, `waiting_for_approval`, `waiting_for_input`, `completed`, `failed`) map to ntfy titles. The redaction rule (a fixed string for a failed run, a 160-character cap) fits Q5. |
| Placement score | `packages/client-runtime/src/load-balancing.ts` | 40 lines. A first M10 can be this score over `yantra-agent`'s heartbeat, with ADR-0013's fields, plus an explanation for `yantra why`. |
| Route list with fail-over and learned addresses | `packages/client-runtime/src/connection/driver.ts`, `supervisor.ts`; `docs/internals/remote.md` | The pattern, not the code: a device holds several routes to one daemon and checks the earlier ones on a network change. Relevant only if Yantra adds a second route. |
| Checkpoints on hidden git refs | `apps/server/src/checkpointing/CheckpointStore.ts` | Per-turn diff and revert inside the Chat worktree, without commits on the user's branch. Re-express in Rust over the ssh transport. |
| Permission modes | `docs/user/permission-modes.md` | Four named modes per thread are a clear UI for ADR-0026's permission card. Note that T3 defaults new threads to Full access; Yantra need not. |
| Orchestrator MCP tool set | `docs/orchestration-v2/orchestrator-mcp-server.md` | `yantra mcp` can add steer, wait-with-timeout and cancel-children from this list. The token per provider session with idle expiry is a sound pattern. |
| Terminal history bounds | `docs/internals/terminal-runtime.md` | 5,000 lines and 8 MiB per terminal, with query/response traffic stripped before replay. Useful for the browser terminal's replay. |
| Provider update by owning installer | `apps/server/src/provider/providerMaintenance.ts` | When `yantra install` grows an update for `claude` and the ACP agents, this is the rule: use the package manager only when the path proves it owns the install. |

## 5. Open questions for the owner

1. **Does Yantra need a route that is not Tailscale?** Without one, a phone off the tailnet cannot
   reach Yantra. T3 Connect's answer is a hosted Cloudflare tunnel. A self-hosted answer would be a
   new ADR against ADR-0016 and R-22, because the bind address is Yantra's whole read-side security
   model today.
2. **Is a native phone app in scope?** Live Activities and reliable push need APNs. A PWA with ntfy
   cannot do Live Activities. This decides whether the phone story ever matches T3 Code.
3. **Should a Chat turn outlive its ssh pipe?** That is R19 §6's keeper. It is where T3 Code is
   weakest (a restart interrupts the turn) and where Yantra already wins for the TUI.
4. **Which coding-loop features first?** Image paste (Y-424) and the multi-harness Chat (Y-434) are
   rows already. Checkpoints with revert, and PR creation from a Chat, are not.
5. **Should Yantra say "use T3 Code" for some cases?** A person on one machine, with no tailnet, who
   wants a phone app today is better served by T3 Code. Saying so in the README is honest, and it
   sharpens what Yantra is for: a fleet, tmux, and no cloud.

## 6. Owner decisions, 2026-10-07

The owner answered the five questions in §5 on 2026-10-07.

1. **No route besides Tailscale.** Tailscale is the whole access model, and ADR-0016 stands.
   Yantra is a personal tool first. A commercial use may come later, and it does not shape the
   design now.
2. **No native phone app now.** The PWA does what the owner needs. The owner may add a native app
   later, if a need appears.
3. **Yes, a Chat turn outlives its ssh pipe.** This is R19 §6 option B, the keeper. It amends
   ADR-0033 decision 7, so it starts with an ADR (Y-446) and then the build (Y-447).
4. **Both coding-loop features.** Checkpoints with revert (Y-448) and a PR from a Chat (Y-449)
   become rows.
5. **No.** Yantra is a standalone project, and its README and docs do not point to T3 Code. The
   MIT licence still requires the notice for each copied file, so `THIRD_PARTY_NOTICES.md` and the
   block comments that ADR-0026 decision 5 asks for stay. They are a licence duty, not a pointer.

## Sources

All accessed 2026-10-07.

- `pingdotgg/t3code` at commit `72d5c32ba67953805feb6fe9ad3b70b632a64c47` —
  <https://github.com/pingdotgg/t3code/tree/72d5c32ba67953805feb6fe9ad3b70b632a64c47>. Read with a
  blobless clone. Files: `README.md`, `LICENSE`, `apps/mobile/README.md`, `apps/server/package.json`;
  `docs/README.md`; `docs/user/` `remote-access.md`, `background-service.md`,
  `mobile-notifications.md`, `permission-modes.md`, `source-control.md`, `providers-acp.md`,
  `providers-claude.md`, `composer.md`, `thread-sidebar.md`, `project-settings.md`, `devices.md`,
  `telemetry.md`, `terminal.md`; `docs/internals/` `overview.md`, `remote.md`, `t3-connect.md`,
  `environment-auth.md`, `providers.md`, `terminal-runtime.md`, `voice-input.md`,
  `resource-telemetry.md`; `docs/orchestration-v2/` `orchestrator-mcp-server.md`,
  `feature-lifecycles.md`; `docs/operations/connect-setup.md`; `infra/relay/README.md`;
  `packages/contracts/src/relay.ts`; `packages/shared/src/agentAwareness.ts`;
  `packages/client-runtime/src/load-balancing.ts`; `apps/server/src/relay/AgentAwarenessRelay.ts`;
  `apps/server/src/cloud/publicConfig.ts`; `packages/ssh/src/tunnel.ts`;
  `apps/server/src/orchestration-v2/Adapters/` (listing).
- GitHub API, `repos/pingdotgg/t3code` — star, fork and licence counts.
- Apple App Store, *T3 Code - Remote Claude & more* —
  <https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824>. The page title answered.
  The Google Play page linked from the README did not return a title to `curl`; it is not verified
  here.
- Yantra: [README](../../README.md), [architecture.md](../architecture.md),
  [`tracker.md`](../../tracker.md), ADR-0011, 0016, 0021, 0023, 0025, 0026, 0028, 0031, 0032, 0033,
  [R15](15-t3code-for-the-chat.md), [R19](19-acp-for-every-harness.md),
  [R20](20-claude-stream-json-turn.md), at `ad8318c`.
