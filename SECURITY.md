# Security policy

Yantra is a personal project maintained by one person in his spare time. This policy says what that
realistically means rather than promising an SLA nobody can keep.

## Supported versions

**None yet.** The project is pre-release: there are no tagged versions and no published binaries.
Only the current `main` is supported. When releases begin, only the latest one will be.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**[Security → Report a vulnerability](https://github.com/2002Bishwajeet/yantra/security/advisories/new)**.

Please do not open a public issue for anything exploitable.

Useful in a report: what an attacker gains, the smallest reproduction, and affected commit.

**What to expect:** an acknowledgement when I next read my notifications — realistically within a
week, not within hours. Fixes land when I have time; a serious issue in an unreleased project will
usually be fixed before it is announced. There is no bounty. Credit in the advisory if you want it.

## Scope

Yantra orchestrates tools that already run on your machines. In scope: the daemon (`yantrad`), the
CLI (`yantra`), the per-machine agent (`yantra-agent`), and this repository's own supply chain.

Out of scope: vulnerabilities in `ssh`, `tmux`, `tailscale`, `docker`/`podman` or the agent CLIs
themselves — report those upstream.

Two design rules are worth knowing when assessing a finding, because a break in either is a real bug:

- **Yantra never stores secrets.** Workspaces hold *references* (1Password, `pass`, sops), never
  values. A code path that persists a secret value is a vulnerability, not a feature request.
- **Local-first, over Tailscale.** Nothing is intended to be exposed to the public internet. A
  default that listens beyond the tailnet is a bug.
