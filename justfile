# Yantra task runner.  `just` with no argument lists everything.

default:
    @just --list

# The gate. Run before every commit.
check: fmt-check lint test deny

# Everything CI runs — the workflow calls these same recipes, so they cannot drift.
ci: check appliance

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all -- --check

# -D warnings is where the workspace clippy lints actually bite.
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
# Y-139's transcript measurement also needs a tmux server started from a GUI
# login on that machine (I-44) and refuses without one — see the test's header.
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
