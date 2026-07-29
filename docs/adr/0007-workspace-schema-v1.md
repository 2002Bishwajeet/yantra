# ADR-0007 — Workspace schema v1, in TOML

- **Date:** 2026-07-29
- **Status:** accepted

## Context

A workspace is the unit of thought in Yantra: the thing you ask for by name. M1 needs the smallest
definition that can drive `yantra up demo` end to end, and needs it on disk in a format a human edits
by hand.

**Format.** YAML was the obvious first choice and turns out to be a bad one in Rust. Checked
2026-07-29 against crates.io:

| Crate | Newest release | Last updated |
| --- | --- | --- |
| `serde_yaml` | `0.9.34+deprecated` | 2024-03-25 |
| `serde_norway` (maintained fork) | `0.9.42` | 2024-12-21 |
| `toml` | `1.1.4` | 2026-07-28 |

The `serde_yaml` maintainer encoded the deprecation into the version string. The fork is itself
nineteen months stale. Adopting either means an abandoned parser sitting on the path that every
workspace file goes through, in a project that runs `cargo deny` in CI precisely to avoid that.

TOML is current, is what the owner already hand-edits daily in `Cargo.toml`, and is a better fit for
flat configuration than YAML anyway.

**Location.** `~/.config/yantra/workspaces/<name>.toml`. Central rather than in-repo, because the
repository need not exist on the machine running the CLI — that is the whole point of a control plane.

**Identity.** The filename *is* the name. There is no `name` key inside the file, so a file and its
name cannot disagree, and `yantra up demo` is a direct path lookup rather than a directory scan.

## Decision

Schema v1 is five fields, four of them on disk:

```toml
machine = "pi"                        # required — an alias, resolved by Y-041
repo    = "/home/biswa/code/demo"     # required — a path ON `machine`
branch  = "main"                      # optional — omitted leaves the tree alone
startup = "claude"                    # optional — omitted means just a shell
```

`name` is the file stem.

Three properties are part of the decision, not incidental:

- **`deny_unknown_fields`.** A mistyped key is an error. Silently ignoring `statup = "claude"` would
  produce a workspace that opens correctly and does nothing, which is the worst kind of bug.
- **Names are validated before they become paths.** A name arrives from the command line and is
  joined to a directory. Empty names, leading dots, `..`, `/`, `\` and NUL are rejected outright, so
  `yantra up ../../etc/passwd` fails as a bad name rather than reading that file.
- **The on-disk type is not the in-memory type.** `OnDisk` is private and has no `name`; `Workspace`
  is public and does. Keeping them separate is what makes the filename-as-identity rule enforceable.

**Explicitly not in v1:** agent selection, environment variables, secret references, port forwards,
multiple panes, machine *preferences* as opposed to a single machine. Each is real and each is
deferred until something needs it. Secrets in particular will be reference-only when they arrive
(§B4), never values.

## Consequences

**Gained**

- No deprecated dependency on the config path.
- A typo in a workspace file fails loudly at load, not silently at run.
- Path traversal via workspace name is closed before Y-041 makes names reach a remote machine.
- v1 is small enough to be obviously right, and additive changes stay backward-compatible because
  every new field will be `#[serde(default)]`.

**Paid**

- `deny_unknown_fields` means adding a field is a breaking change for anyone who wrote it early. At
  one user, this is the right trade.
- TOML has no comfortable multi-line list-of-commands syntax, so `startup` is a single command
  string. If M1 shows that is too thin, it becomes an array — an additive change.
- `etcetera` rather than `dirs` for locating the config directory: `dirs` pulls `option-ext`
  (MPL-2.0), which the licence allow-list rejects, and its macOS config dir is
  `~/Library/Application Support` rather than the `~/.config` documented here.

**Deferred**

- Schema versioning. There is no `version` key. Adding one before there is a second version is
  guessing at the migration; the file is small enough to detect shape from its contents if that day
  comes.
