# ADR-0036 — The dashboard layout syncs through the daemon

- **Date:** 2026-10-19
- **Status:** Accepted 2026-10-19 by the owner ([Y-515](../../tracker.md)), with no changes.
- **Evidence:** [the M17 plan](../plans/m17-the-personal-dashboard.md) §5. On 2026-10-19 the owner
  chose "Approve, but sync layouts across devices".
- **Amends** [ADR-0024](0024-the-dashboard-is-material-3-built-by-hand.md) §5 (preferences are
  browser-local) and [ADR-0021](0021-the-relay-is-written-to-an-environment-file.md), whose
  2026-08-22 amendment says the daemon writes one file.

## Context

M17 makes `/` a grid of widgets that the owner arranges. The plan kept each layout in the browser's
`localStorage` and offered a link to copy a layout to another device. The owner wants the phone, the
iPad and the laptop to share their layouts with no link.

Two rules stand in the way. ADR-0024 §5 keeps preferences in the browser. CLAUDE.md §B1 says the
daemon persists nothing about the fleet and writes exactly one file, `/etc/yantra/daemon.env`, which
is configuration. A layout is not fleet state: it says nothing about a machine, a session or a
workspace. It is the owner's preference, like the appearance settings.

## Decision

1. **The daemon keeps the layout in one file**, `dashboard.json`, in the config directory of the
   account it runs as (`~/.config/yantra/dashboard.json`, beside the workspace files). It holds
   `{ v, rev, phone, tablet, desktop }`. Each form factor keeps its own layout, as in the plan.
2. **`GET /api/layout` reads it, and `PUT /api/layout` replaces it.** A missing file answers the
   default layout with `rev: 0`. The PUT calls `allowed()` (ADR-0016) and adds its `yantra layout`
   verb (ADR-0012).
3. **A stale write is refused.** The PUT sends the `rev` it read. If the file has a newer `rev`, the
   daemon answers 409 with the current layout, and the browser takes it and says so. The daemon writes
   the file atomically (write a temporary file, then rename it).
4. **The browser keeps a copy in `localStorage`** under `yantra.dashboard`, and draws from it at once.
   It reads the daemon's layout in the background and replaces its copy when the `rev` is newer. A
   browser that cannot reach the daemon still draws its last copy.
5. **The file holds no secret, and nothing in it names a value a workspace resolves** (§B4). Widget
   ids, sizes and workspace names for the Spend widget are the only content.
6. **Appearance stays browser-local.** ADR-0024 §5 still holds for Clean or Compact, the seed and the
   theme. Only the layout moves.

## Consequences

- The daemon now writes two files: `daemon.env` (configuration it reads at start) and
  `dashboard.json` (a preference it serves). CLAUDE.md §B1 and the ADR-0021 amendment get a dated
  note. The daemon still persists nothing about the fleet.
- Losing the file loses only the layout. Every device then falls back to its local copy, and then to
  the default.
- The layout link (plan Y-514) is no longer needed. The owner's walk stays in Y-514.
- A podman test proves the 409 path and the atomic write. A unit test proves the guard drops an
  unknown widget id and a bad size.
