# M15 — the release you can install, and the box that stays current

**Planned 2026-09-08.** Rows Y-364 to Y-369. The milestone is done when the owner's Pi installs a
published release in one command, runs the Material dashboard from it, and says when a newer release
exists.

v0.1.0 shipped on 2026-08-09 and nothing has been tagged since. Four milestones of work sit on
`main` with no way for the appliance to get at it except `just appliance-install`, which is a
developer pushing binaries from their own box.

---

## 1. What gates the tag

M14 closes first. The release is the milestone's proof, not a way around it.

| Gate | Row | State on 2026-09-08 |
| --- | --- | --- |
| The first load is inside its ceiling | Y-370 | 147.6 KiB, and the ceiling is being replaced |
| The budget is a failing test, not a note | ledger row 84 | rides with Y-370 |
| The review nits are closed or refused | Y-360 | three sweeps in flight |
| e2e, axe and the budget green at three sizes | Y-352 | two of three |
| The whole-system documents say what shipped | Y-369 | not started |

Nothing else blocks a tag. `release.yml` last ran on v0.1.0's tag and has not been exercised since,
which is the reason §2 rehearses before it publishes.

## 2. The rehearsal, then the tag

`release.yml` already carries a `workflow_dispatch` trigger that builds the whole matrix and uploads
the archives **without publishing**. Use it. A tag is not the place to discover that a toolchain
pin moved.

1. Bump `version` in the root `Cargo.toml` to `0.2.0` — every crate reads `version.workspace = true`,
   so one line moves all four.
2. Run `release.yml` on `workflow_dispatch` from `main`. Four archives must appear:
   `aarch64-unknown-linux-musl` and `x86_64-unknown-linux-musl` carrying `yantrad`, `yantra` and
   `yantra-agent`; two Apple targets carrying `yantra-agent` alone.
3. Download the aarch64 archive and check the three things the workflow claims: the binaries are
   static, they are aarch64, and `yantrad` contains the embedded dashboard.
4. Tag `v0.2.0` and push. The `release` job aggregates `SHA256SUMS`, verifies it, and publishes.
5. Install the published release on the appliance and open the dashboard on the phone.

**Windows is absent from the matrix and stays absent.** `probes.rs` carries a `compile_error!` for
any other target while Q4 is open, so a Windows entry would claim an artifact the code refuses to
build.

## 3. The installer follows the release

`install.sh` pins `VERSION=0.1.0` and a commit hash. A release nobody can install without editing
the script is not a release.

- The default version resolves to the current release rather than a number written into the file.
  `SHA256SUMS` still verifies what arrives, so resolving the version does not weaken the check.
- Y-159 is the other half: the script is served from `raw.githubusercontent.com` at a pinned commit
  today, and the row asks for a name that resolves off the tailnet. The landing site already
  deploys from `landing.yml`.
- The systemd units are fetched by commit, not from the archive. Either the archive carries them or
  the commit pin moves with each release; the second is a step somebody forgets.

## 4. Staying current — the operator presses the button

**ADR-0013 forbids the obvious answer.** Its non-goals close "no self-update and no
daemon-initiated update", because a control plane that pushes a binary to five machines is the
fleet-management product this project exists not to be (R-12). The same ADR leaves "how a machine
stays current" explicitly undecided.

So the fleet stays closed and only the appliance is in question. **The owner picked on 2026-09-08: the operator
presses the button.** The daemon reads the published version — it holds a
GitHub token already, under ADR-0023 — the About screen says a newer release exists, and `yantra
update` applies it. Nothing is fetched or applied unattended.

The two shapes it beat, and why they are written down: **a systemd timer** would keep ADR-0013's
words intact, because nothing in the daemon fetches anything, but it can restart the box while the
owner is working in it. **A daemon that polls and applies** is cheapest to use and contradicts
ADR-0013 head-on.

Two things hold whatever the mechanism: the release is verified against `SHA256SUMS` before anything is
installed, and a machine that Yantra merely reaches over ssh never receives a binary.

## 5. What a restart must not cost

`systemctl try-restart yantrad` is how an update lands. A tmux session lives in a tmux server owned
by the login user, not by `yantrad`, so a session survives — but the dashboard's WebSocket does not,
and Y-368 does not close until a podman test proves both halves of that sentence.

## 6. Rollback

The installer writes `<name>.new` and renames it over the live binary, which avoids `ETXTBSY` and
costs nothing to reverse **if the previous binary is kept**. Today it is not. ADR-0027 says whether
it should be.

## 7. Out of scope

- macOS has neither unit nor installer. It ships `yantra-agent` alone and a person runs it by hand.
  Nothing here changes that.
- No release cadence. A tag is cut when there is something worth installing.
- No auto-update on any machine that is not the appliance. That is the half ADR-0013 closed.
