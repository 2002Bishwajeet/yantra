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
test-mac machine:
    YANTRA_MAC={{machine}} cargo test -p yantra-core --test manual_macbook -- --ignored --nocapture

build:
    cargo build --workspace

# Licence + security-advisory audit. Cheap hygiene for a 24/7 daemon.
deny:
    cargo deny check

# Cross-compile the appliance binaries for the Pi 5 / arm64 target.
appliance:
    cargo zigbuild --release --target aarch64-unknown-linux-musl \
        -p yantrad -p yantra -p yantra-agent

# Size and startup are quality targets carried over from ADR-0003's
# measurement discipline; the appliance milestone (M7) reports both.
appliance-size: appliance
    @ls -lh target/aarch64-unknown-linux-musl/release/yantrad \
            target/aarch64-unknown-linux-musl/release/yantra \
            target/aarch64-unknown-linux-musl/release/yantra-agent
