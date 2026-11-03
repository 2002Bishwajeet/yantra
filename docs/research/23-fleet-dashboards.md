# R23 — How other fleet dashboards work, against Yantra

**Asked 2026-10-31 by the owner (#518), built as Y-577 on 2026-11-03.** The owner reviewed the
dashboard and found screens a new person cannot explain. The owner asked whether we had looked at
how other products do this. We had not. This note looks at six products that manage machines or
services, with T3 Code as the coding reference, and it ends with changes for open rows.

- **Read against:** the Yantra screens that the findings feed, on `main` at `7cc7057a`:
  `web/src/screens/fleet` (`Fleet.tsx`, `Github.tsx`), `web/src/screens/machines` (`Machines.tsx`,
  `MachineCard.tsx`, `Unclaimed.tsx`, `facts.ts`), `web/src/screens/settings` (`Access.tsx`,
  `About.tsx`) and `web/src/screens/setup`. Also issues #513, #514, #517, #518 and #522, and rows
  Y-578, Y-580, Y-581, Y-582, Y-586 and Y-587 in [`tracker.md`](../../tracker.md).
- **Every claim says one of:** *docs* (the vendor's documentation), *source* (the vendor's source
  code), *release* (the GitHub release API), or *Yantra* (this repository). Nothing here was run, and
  no screenshot was taken ([What this note did not do](#what-this-note-did-not-do)).
- **Where a page did not answer, the table says "not found".** It does not guess. The most useful
  sentence in a research note is the one that says what you could not confirm.

| Product | Version read | Release date |
| --- | --- | --- |
| Coolify | v4.6.0 | 2026-11-02 |
| Portainer CE | 2.45.3 | 2026-10-21 |
| Proxmox VE | 9.2 (docs 9.2.13) | 2026-05-21 (x86-64), 2026-08-05 (arm64) |
| Home Assistant Core | 2026.10.4 | 2026-10-24 |
| Tailscale | admin console, no version number | live docs, 2026-11-03 |
| Vercel | dashboard, no version number | docs pages last updated 2026-08-11 and 2026-09-17 |
| T3 Code | `main` at `cefb544` (2026-11-03), newest nightly `v0.1.7-nightly.20261103.4119` | 2026-11-03 |

## Result

**One or two products back each of four patterns, and Yantra's dashboard breaks each of them.** No pattern has more than two sources, and pattern 3 has one, so read them as patterns and not as an industry consensus.

1. **The first run asks for one thing and shows the result.** Two products: Coolify and Home Assistant. Coolify asks for an admin account, then
   walks the owner through a server, a project and a first resource. Home Assistant asks for an owner
   account, a location, an analytics choice, and then lists what it found. Yantra's setup asks the
   owner to add the appliance as a machine (#517).
2. **The host is shown once, first, and apart.** Two products: Coolify and Portainer. Proxmox does not set the host apart. Tailscale and Home Assistant gave no answer. Coolify names the server that runs it "localhost"
   and says in the docs that it cannot be removed. Portainer detects "the local environment it's
   running on" without being asked. Yantra lists the appliance beside every other machine (#517).
3. **A page for a thing leads with its state and its numbers.** One product shows a machine page: Proxmox. Tailscale shows only a list filter. Vercel leads with deployments. Home Assistant was not found. Proxmox leads a node with resource
   usage and the actions Reboot, Shutdown and Shell. Tailscale searches machines by name, address,
   user, system and client version. Yantra's card leads with "no beat has arrived" (#514).
4. **Words stay close to the owner's task.** Two products: Home Assistant and Vercel. Home Assistant says "Integration" and "Dashboard".
   Vercel says "project" and "deployment". Yantra's pages show "I-" and `ADR` references and words
   such as "beat" (#514).

**Nothing found says what to do with a section that has nothing to show.** Two products answer: Coolify and Home Assistant ("All set!").
Coolify's source hides a control when it has no option to offer (no projects, no
SSH keys). That agrees with the rule in #514, and Yantra can adopt it without any product copying it.

The comparison does **not** show that Yantra should look like any of these products. Yantra has no
deploy step, no project and no cloud account. It has machines, sessions and issues that wait for the
owner. The findings below change how Yantra names and orders those things. They do not add concepts.

## Table: one product per row, one question per column

| Product | First run asks | Own host against managed machines | A machine or service page shows first | Vocabulary | Hides when empty |
| --- | --- | --- | --- | --- | --- |
| **Coolify** | An admin account. Then a wizard: server type, project, first resource. *Docs, source.* | "This machine" (the server that runs Coolify) is one choice beside "IP address or domain". The docs call it localhost, say it cannot be removed, and warn it shares CPU, memory and disk with the dashboard. *Docs, source.* | Not found. The docs list what a server holds (connection, timezone, wildcard domain, cleanup schedule) but not its layout. | Server, project, environment, resource. | Hides the project picker with no project and the key picker with no key. *Source.* |
| **Portainer** | An admin account (12 characters or more) and a setup token read from the server log. A step for Edge Compute that the owner can skip. *Docs.* | The wizard "detects and sets up the local environment it's running on". The owner clicks Get Started or Add Environments. *Docs.* | Not found. The environments page does not describe the home screen. | Environment (renamed from "endpoint" in 2.10), group, tag, Edge Agent. | Not found. |
| **Proxmox VE** | The installer asks for disk, location, root password, email and one network address. The first login suggests a subscription key, hostname, time zone and firewall review. *Docs.* | The node sits in a tree under Datacenter. Server View groups node, guests and storage. Datacenter holds cluster settings. A Log Panel shows recent tasks. *Docs.* | The node summary shows resource usage. The header has Reboot, Shutdown, Shell and Bulk Actions. *Docs.* | Datacenter, node, guest, storage, pool, task. | Not found. |
| **Home Assistant** | An owner account or a backup restore. Then location, an analytics choice (off by default) and a list of discovered devices, or "All set!". *Docs.* | Not found as a separate screen in the docs. Settings > System > Hardware shows memory use; the OS 10 release post says so. The page itself was not read. *Release post.* | Not found in the docs. The entity registry fields `entity_category` and `entity_registry_visible_default` exist, so some entities start hidden. How the device page uses them was not confirmed. *Source docs.* | Integration, device, entity, area, dashboard, backup, owner account. | Shows "All set!" when discovery finds nothing. *Docs.* |
| **Tailscale** | Sign in with a single sign-on account, pick Business or Personal use, add a first device, optionally a second, then "Take me home". *Docs.* | Not found. No source described a "this device" marker on the Machines page. | The list searches name, hostname, Tailscale IP, user, system and client version. Filters include "Last seen". A machine's detail section carries its ID and addresses. *Docs.* | The console says "Machines". The docs say "device". The docs treat the two words as one thing. | Not found. The docs do not describe an empty Machines page, because onboarding adds a device first. |
| **Vercel** | An account. Then New Project: connect Git, pick a repository, click Deploy. The CLI route is `vercel login` then `vercel`. *Docs.* | Not applicable. Vercel has no host the owner runs. | A project dashboard for a selected project: deployments, settings, logs, observability. *Docs.* | Team, project, deployment, environment (production, preview), domain. | Not found. The empty state of a new account was not read. |
| **T3 Code** | `t3 serve`, or the desktop app. A pairing link carries a one-time secret in its URL fragment. *R21, docs.* | Each machine is an "environment" with a stable ID and an ordered list of routes. The desktop app runs a local server beside any remote one. *R21, code.* | A thread list per project. *R21.* Not re-read in this note. | Environment, project, thread, provider. | Not re-read. |

## 1. What the first run asks of a new owner

**Each product asks for an owner account and then stops asking.** Home Assistant is the clearest.
Its steps are account, location, analytics, discovered devices, finish. Each step takes one
decision. The analytics step is off by default. The last step either lists what it found or says
"All set!".

**Coolify teaches by doing.** The wizard shows what the owner will set up before it starts ("Server
connection", "Docker environment", "Project structure"), offers "Skip setup", and ends with a
checklist of what is configured. Its server step says "You can add more servers later." That one
sentence removes the pressure to add everything now.

**Portainer and Proxmox ask about the host, not the fleet.** Portainer asks for a setup token that
the owner reads from the server log. Proxmox asks for disk, password and network address. Neither
asks the owner to add the machine the software is running on.

**Yantra today.** Setup step 2 reads "Add a machine", and the appliance is among the choices
(`web/src/screens/setup/Setup.tsx`, #517). Setup also lists "Devices that open the dashboard", which
has no setup task. Step 3 waits for one ready machine.

**For Yantra.** Setup counts the hub as done with step 1 and offers only other machines in step 2.
It says that more machines can be added later. It shows a short list of what setup configures, in
the way of the Coolify checklist. (Y-582.)

## 2. How the product shows its own host against the machines it manages

**Two products treat the host as special, and both treat it first.** Coolify calls the host
"localhost" in its docs and "This machine" in its wizard. It cannot be removed. The docs warn about
resource contention and recommend a remote server for production. Portainer detects the local
environment on its own and starts managing it before the owner asks.

**Both keep the host usable for work.** Coolify lets the owner deploy to localhost and says so.
Portainer's local environment is a normal environment for every purpose. The hub is special in how it
is shown and not in what it can do.

**Proxmox puts the host in a tree.** A node is the host in a single-node install. There is no special
"this machine" marker in the docs, because the node is the whole product. This pattern fits a
cluster and does not fit Yantra.

**Tailscale and Home Assistant gave no answer.** No source we read marks "this device" on the Tailscale
Machines page. The Home Assistant docs we read do not set the host apart from its devices.

**Yantra today.** `Machines.tsx` lists the appliance in the same list as the others, and #517 asks
for the daemon to name its own host. The nearest pattern is Coolify's: one named hub, shown first,
with a note about resource contention and a normal ability to run agents.

**For Yantra.** The daemon names its host. Machines shows it first and apart, with its health. Setup
never offers it as a machine to add. The owner can still run Claude Code there. A short note says
that agents on the hub share its CPU and memory with `yantrad`, in the way Coolify warns. (Y-582.)

## 3. What a machine or service page shows first

**Proxmox and Tailscale lead with identity, state and numbers.** The Proxmox node header offers the
verbs an owner reaches for (Reboot, Shutdown, Shell) above a resource summary. Tailscale's search
fields (name, hostname, address, user, system, client version) show what an owner asks about a
machine.

**Vercel's docs put deployments first.** They say a selected project opens a dashboard where the
owner can "inspect deployments and configure its settings". The docs do not describe the layout.

**Home Assistant hides detail by category.** The entity registry marks entities as `config` or
`diagnostic`, and has a visible-by-default flag. We did not confirm how the device page uses them, so
treat this as a lead for Y-578, not a finding.

**Yantra today.** `MachineCard.tsx` leads with a heartbeat phrase ("no beat has arrived") and
`facts.ts` returns "not asked yet" when no check has run. The card does not lead with readiness or
with CPU, memory and disk (#514).

**For Yantra.** The card leads with one plain status word, the machine's name, and three numbers:
CPU, memory and disk. Sessions on the machine follow. The check result follows that, with the next
step if it failed. Verbs (Check again, Open a terminal) sit in the header, as in Proxmox. (Y-580.)

## 4. What vocabulary the product uses

**Each product has four to six nouns, and each noun has one meaning.** Coolify has server, project,
environment, resource. Vercel has team, project, deployment, environment, domain. Home Assistant has
integration, device, entity, area. Portainer renamed "endpoint" to "environment" in 2.10 because the
old word did not match what owners called the thing. Tailscale uses "device" in its docs and
"Machines" in its console, and the docs treat them as one thing. That mismatch is a cost: a reader
has to learn that two words mean one thing.

**None of them shows an internal identifier as a label.** The products do not print their own
invariant numbers, design-record numbers or protocol words in the page.

**Yantra today.** The Machines page prints "no beat has arrived", "not asked yet" and references with
`ADR` and `I-` (#514). Fleet uses "Needs you", "Running" and "Idle" as band names, and "Fleet" as
the page title, which a new person cannot explain (#513).

**For Yantra.** Pick one word for a computer (the code says *machine*; keep it) and one for the
dashboard's own host (*hub*, from #517). Remove `ADR` and `I-` references from every page a person
reads. Replace "beat" with "last seen", which is the word Tailscale's filter uses. (Y-580.)

## 5. What the product hides when there is nothing to show

**The one source-backed rule is Coolify's.** Its onboarding source hides the project picker when no
project exists, and hides the key picker when no key exists. The owner sees only the action that is
left. Home Assistant shows "All set!" in place of an empty list of discovered devices.

**Portainer, Proxmox, Tailscale and Vercel gave no answer** in the pages we read. A product page
could hide an empty section, but the docs do not say. Do not count them as agreeing.

**Yantra today.** "Worth a look" stays on screen with nothing in it, and "Devices that open the
dashboard" lists phones the owner has no reason to manage there (#514). The Fleet page draws
"Nothing needs you" and "Nothing is running" as full cards.

**For Yantra.** A section with no content and no action is not drawn. A section with an action shows
the action alone, in the way of the Coolify project step. A page that is empty everywhere says "All
set" in one line, in the way of Home Assistant. (Y-580, Y-581.)

## Changes for Yantra

Each change links one row. Nothing here creates a row.

| # | Change | Row |
| --- | --- | --- |
| 1 | The machine card leads with one plain status, then CPU, memory and disk, then sessions, then the check result. Move verbs to the card header. | Y-580 |
| 2 | Replace "no beat has arrived" with "last seen" and "not asked yet" with "not checked". Remove `ADR` and `I-` references from every page a person reads. | Y-580 |
| 3 | Do not draw an empty section that has no action. "Worth a look" and "Devices that open the dashboard" are the first two. | Y-580 |
| 4 | **Check again** works with no workspace, and shows a result or a plain failure with the next step. This matches Coolify's "Server is not reachable" with a "Check again" button. | Y-580 |
| 5 | The Fleet page says in one line what it is for. One row pattern serves the phone and the desktop. The most urgent issue stands out. | Y-581 |
| 6 | The Fleet page draws no card for an empty band. When all bands are empty it says "All set" once. | Y-581 |
| 7 | The daemon names its own host. The dashboard calls it the *hub*, shows it first and apart, and shows its health. | Y-582 |
| 8 | Setup counts the hub as done with step 1. Step 2 lists only other machines and says that more can be added later. | Y-582 |
| 9 | A one-line note on the hub: agents there share its CPU and memory with `yantrad`. This is Coolify's contention warning. | Y-582 |
| 10 | Remove "Devices that open the dashboard" from Setup. | Y-582 |
| 11 | The SSH key belongs in Add a device, where the join command uses it, as the Coolify docs put the key next to server connection. Listen addresses and file paths move to a collapsed diagnostics section or go. | Y-587 |
| 12 | Settings > About says in plain words who can open the dashboard: only devices on the tailnet, with no separate login. | Y-587 |
| 13 | Setup ends with a short list of what is configured, in the way of Coolify's "Setup complete" checklist. | Y-582 |

**Proposals with no row yet, for the ship stage to file or drop:**

- *A "Last seen" filter on Machines*, after Tailscale's filter, once Y-580 lands. It needs more than
  three machines to earn its place; the owner has not said how many to expect.
- *Entity-category thinking for Y-578's audit:* decide for each fact on a card whether it is primary
  or diagnostic, and collapse the diagnostic ones. Y-578 may name this in its findings.
- *A task log panel*, after Proxmox's Log Panel, to show recent actions across the fleet. Yantra has
  events (ADR-0025). This is a feature and not a fix, and it needs the owner's choice.

## What this note did not do

**No screenshot was taken.** Issue #518 asks for screenshots on current versions. The Tailscale and
Vercel consoles need the owner's accounts. Running Coolify, Portainer, Proxmox VE and Home Assistant
locally would load the build machine's memory, which this run must not use. The sources below link
each vendor's documentation, where the official screenshots live, and state the access date.
The tracker's done condition for Y-577 does not ask for screenshots. A later pass with the owner's
accounts, or a short-lived container for each open-source product, can add them.

**Several answers are "not found".** The documentation pages we fetched did not describe the
Portainer home screen, the Coolify server page, the Home Assistant device page, the Tailscale
empty state or the Vercel empty state. A reader who wants those answers must open the product.

**T3 Code was not re-read in depth.** R15 and R21 read it at `72d5c32` (version 0.0.45). The newest
tag on 2026-11-03 is `v0.1.7-nightly.20261103.4119`, and `main` is at `cefb544`. The version moved
a long way in four weeks. Re-read the code before building on R21's claims.

**Fetched pages are summaries.** The documentation fetcher returns a model's answer to a question
about each page, not the page text. A quoted phrase above comes from that answer. Check a phrase on
the live page before it goes into the product.

## Sources

All accessed 2026-11-03.

- Coolify, *Introduction* — <https://coolify.io/docs/get-started/introduction>
- Coolify, *Servers* — <https://coolify.io/docs/knowledge-base/server/introduction>
- Coolify, *Installation* — <https://coolify.io/docs/get-started/installation>
- Coolify source, onboarding view —
  <https://raw.githubusercontent.com/coollabsio/coolify/v4.x/resources/views/livewire/boarding/index.blade.php>
- Coolify release API — <https://api.github.com/repos/coollabsio/coolify/releases/latest> (`v4.6.0`)
- Portainer, *Install on Docker Linux* — <https://docs.portainer.io/start/install-ce/server/docker/linux>
- Portainer, *Initial setup* — <https://docs.portainer.io/start/install-ce/server/setup>
- Portainer, *Environments* — <https://docs.portainer.io/admin/environments>
- Portainer release API — <https://api.github.com/repos/portainer/portainer/releases/latest> (`2.45.3`)
- Proxmox VE, *Graphical User Interface* (docs 9.2.13) —
  <https://pve.proxmox.com/pve-docs/chapter-pve-gui.html>
- Proxmox VE, *Installation* — <https://pve.proxmox.com/wiki/Installation>
- Proxmox VE, *Roadmap* (release dates) — <https://pve.proxmox.com/wiki/Roadmap>
- Home Assistant, *Onboarding* — <https://www.home-assistant.io/getting-started/onboarding/>
- Home Assistant, *Hardware integration* — <https://www.home-assistant.io/integrations/hardware/>
- Home Assistant OS 10 release post (memory under Settings > System > Hardware) —
  <https://www.home-assistant.io/blog/2023/04/18/home-assistant-os-release-10/>
- Home Assistant contributors, *Entity class* —
  <https://contributors.home-assistant.io/core/entities/entity-class/>
- Home Assistant Core release API — <https://api.github.com/repos/home-assistant/core/releases/latest> (`2026.10.4`)
- Tailscale, *Install and sign up* — <https://tailscale.com/kb/1017/install>
- Tailscale, *Filter devices in the admin console* — <https://tailscale.com/kb/1176/filter-devices/>
- Vercel, *Projects overview* (page updated 2026-09-17) — <https://vercel.com/docs/projects/overview>
- Vercel, *Getting started* (page updated 2026-08-11) — <https://vercel.com/docs/getting-started-with-vercel>
- T3 Code, commit and release APIs — <https://api.github.com/repos/pingdotgg/t3code/commits?per_page=1>,
  <https://api.github.com/repos/pingdotgg/t3code/releases?per_page=1>
- Yantra: [R15](15-t3code-for-the-chat.md), [R21](21-t3code-and-yantra.md),
  [`tracker.md`](../../tracker.md), issues #513, #514, #517, #518 and #522, and the screens listed at
  the top, at `7cc7057a`.
