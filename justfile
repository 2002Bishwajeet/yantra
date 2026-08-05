# Yantra task runner.  `just` with no argument lists everything.

default:
    @just --list

# The gate. Run before every commit.
check: fmt-check lint test deny no-node

# Everything CI runs — the workflow calls these same recipes, so they cannot drift.
ci: check appliance

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all -- --check

# -D warnings is where the workspace clippy lints actually bite.
#
# **No `--all-features` here or in `test` below, and the omission is the point**
# (Y-140). `yantrad`'s `embed-dashboard` compiles `web/dist` in, so one
# `--all-features` added for tidiness would put npm on `clippy`, on `test` and
# on the musl cross-build at once — R-24 exactly as it is written. `no-node`
# reds the build if it ever appears.
lint:
    cargo clippy --workspace --all-targets -- -D warnings

# --no-tests=pass so a crate with no tests yet is not a failure. Remove this
# once every crate has tests and an empty suite genuinely means something broke.
test:
    cargo nextest run --workspace --no-tests=pass

# CI-only: the sshd fixture (Y-031) must run, not skip. `just test` stays
# skip-friendly for machines without podman (docs/development.md).
test-ci:
    YANTRA_REQUIRE_PODMAN=1 cargo nextest run --workspace --no-tests=pass

# The checks no container can make (I-34, ADR-0009). Needs the machine to be
# reachable and named in ~/.ssh/config; CI cannot run these and does not try.
# Two of them also need a tmux server started from a GUI login on that machine
# (I-44) and refuse without one — Y-139's transcript measurement and Y-151's
# gate, which is the only place ADR-0018's launchd half can be measured at all.
# See each test's header.
test-mac machine:
    YANTRA_MAC={{machine}} cargo test -p yantra-core --test manual_macbook -- --ignored --nocapture

build:
    cargo build --workspace

# Rewrite web/src/contract.gen.ts from the routes themselves (Y-124). `just test`
# compares the two, so a DTO that moved without this is a red build.
fixtures:
    YANTRA_FIXTURES=1 cargo test -p yantrad contract

# TLS for the dashboard, so a phone can open it (docs/development.md). 8443
# because `/` on 443 is code-server's, and the tailnet address because Y-069
# has the daemon refuse loopback. Set once per machine; `--bg` persists it.
https:
    tailscale serve --bg --https=8443 "http://$(tailscale ip -4):7717"

https-off:
    tailscale serve --https=8443 off

# Licence + security-advisory audit. Cheap hygiene for a 24/7 daemon.
deny:
    cargo deny check

# Cross-compile the appliance binaries for the Pi 5 / arm64 target.
appliance:
    cargo zigbuild --release --target aarch64-unknown-linux-musl \
        -p yantrad -p yantra -p yantra-agent

# R-24's assertion, and it is a negative one: no recipe the Rust gate runs may
# turn `embed-dashboard` on, pass `--all-features`, or reach npm. A green build
# says nothing about which jobs needed npm to succeed, so this reads the recipes
# and the workflows rather than the result. Part of `check`, not a note.
no-node:
    #!/usr/bin/env bash
    set -euo pipefail
    feature=embed-dashboard
    forbidden="--all-features|$feature|npm |npx "

    # Every recipe `just ci` reaches except this one — `ci` is `check` plus
    # `appliance`, and `check` is the five below plus `no-node`. `--dry-run`
    # renders each with its dependencies and runs none of them, so what is read
    # here is what would actually run.
    for recipe in fmt-check lint test test-ci deny build appliance; do
      if just --dry-run "$recipe" 2>&1 | grep -qE -- "$forbidden"; then
        echo "no-node: \`just $recipe\` would need npm, so the Rust gate no longer builds without Node (R-24)" >&2
        exit 1
      fi
    done

    # ci.yml has no path filter, so a Node step there runs on every Rust pull
    # request. The job that does build with the feature lives in embed.yml.
    # Comment lines are dropped first: what matters is what a workflow does, and
    # both files have reason to name the hazard in prose.
    steps() { grep -hvE '^\s*#' "$@"; }

    if steps .github/workflows/ci.yml | grep -qE -- "$feature|actions/setup-node|npm |npx "; then
      echo "no-node: ci.yml has acquired a Node dependency, which is R-24 in full" >&2
      exit 1
    fi

    if steps .github/workflows/*.yml | grep -qE -- '--all-features'; then
      echo "no-node: --all-features turns $feature on wherever it appears" >&2
      exit 1
    fi

    # This recipe asserts what ci.yml does, so a ci.yml that stopped running it
    # would pass every line above. Measured on Y-140's own branch, where the job
    # was written and then lost to a `git checkout`, green.
    if ! steps .github/workflows/ci.yml | grep -qE -- 'just no-node'; then
      echo "no-node: ci.yml no longer runs this check, so nothing asserts any of the above on a pull request" >&2
      exit 1
    fi

    # Unreachable from a default build, rather than merely unused by one: an
    # optional dependency that got promoted would still want web/dist.
    if cargo tree -p yantrad --edges normal | grep -q include_dir; then
      echo "no-node: include_dir is in yantrad's default dependency graph, so the default build wants web/dist" >&2
      exit 1
    fi

# The dashboard's own build. Same rule as the landing recipes below: it needs
# npm, so nothing reachable from `ci` or `check` may depend on it.
web-build:
    npm --prefix web ci
    npm --prefix web run build

# M7's one file to copy: the appliance daemon with the dashboard inside it.
appliance-embedded: web-build
    cargo zigbuild --release --target aarch64-unknown-linux-musl \
        -p yantrad --features embed-dashboard
    @ls -lh target/aarch64-unknown-linux-musl/release/yantrad

# The feature's tests. `just test` cannot run them by accident — the module they
# live in does not exist without the feature.
test-embedded: web-build
    cargo nextest run -p yantrad --features embed-dashboard

# The landing site. Deliberately absent from `ci` and `check` — R-24's retire
# condition is that the Rust gate stays green on a machine with no Node
# installed, so nothing here may become a dependency of either.
landing-build:
    cd landing && npm ci && npm run build

landing-visual:
    cd landing && npm ci && npx playwright install --only-shell chromium && npm run test:visual

# Size and startup are quality targets carried over from ADR-0003's
# measurement discipline; the appliance milestone (M7) reports both.
appliance-size: appliance
    @ls -lh target/aarch64-unknown-linux-musl/release/yantrad \
            target/aarch64-unknown-linux-musl/release/yantra \
            target/aarch64-unknown-linux-musl/release/yantra-agent
