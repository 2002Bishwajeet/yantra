# Yantra task runner.  `just` with no argument lists everything.

default:
    @just --list

# The gate. Run before every commit.
check: fmt-check lint test

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
