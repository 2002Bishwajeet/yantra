# Yantra task runner.  `just` with no argument lists everything.

# Pinned per checkout: a target dir shared between worktrees serves one
# worktree's stale test binary to another (Y-326), so the profile's must not leak in.
export CARGO_TARGET_DIR := justfile_directory() / "target"

# Q15 has not answered which box and `Pi 5 / N100` is two architectures, so
# this is the default rather than the answer (docs/appliance.md).
appliance_target := "aarch64-unknown-linux-musl"

appliance_stage := "/tmp/yantra-install"

default:
    @just --list

# The gate. Run before every commit.
check: fmt-check lint test deny no-node pinned

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

# Cross-compile the appliance binaries. Defaults to arm64; `just appliance
# x86_64-unknown-linux-musl` is the mini-PC that M7's own `Pi 5 / N100` implies.
appliance target=appliance_target:
    cargo zigbuild --release --target {{target}} \
        -p yantrad -p yantra -p yantra-agent

# R-24's assertion, and it is a negative one: no recipe the Rust gate runs may
# turn `embed-dashboard` on, pass `--all-features`, or reach npm. A green build
# says nothing about which jobs needed npm to succeed, so this reads the recipes
# and the workflows rather than the result. Part of `check`, not a note.
# Every `uses:` names a 40-hex commit. A tag is mutable — a major tag is
# repointed at every release, and any tag can be force-pushed — and an action
# runs arbitrary code with the job's token, which for `release.yml` can publish.
pinned:
    #!/usr/bin/env bash
    set -euo pipefail

    # `uses: ./…` is this repo's own composite actions, which move with the
    # commit that reads them and cannot be repointed by anyone else.
    floating=$(grep -rn --include='*.yml' --include='*.yaml' -E '^[[:space:]]*-?[[:space:]]*uses:' .github \
      | grep -vE 'uses:[[:space:]]*\./' \
      | grep -vE 'uses:[[:space:]]*[^@]+@[0-9a-f]{40}([[:space:]]|$)' || true)

    if [ -n "$floating" ]; then
      echo "pinned: these actions name a tag rather than a commit:" >&2
      echo "$floating" >&2
      exit 1
    fi
    echo "pinned: every action names a commit"

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

    # The behavioural half, asserted for the same reason as the job above: a
    # check nothing runs asserts nothing.
    if ! steps .github/workflows/ci.yml | grep -qE -- 'just build-without-node'; then
      echo "no-node: ci.yml no longer builds with node shadowed, so nothing exercises R-24's condition itself" >&2
      exit 1
    fi

# What `no-node` cannot read: it greps the recipes, this runs two of them with
# node, npm and npx shadowed by stubs that fail. It names the three binaries in
# order to remove them, which is why that recipe's list cannot include this one.
build-without-node:
    #!/usr/bin/env bash
    set -euo pipefail
    stubs=$(mktemp -d)
    trap 'rm -rf "$stubs"' EXIT
    for tool in node npm npx; do
      printf '#!/bin/sh\necho "%s: absent here by design (R-24)" >&2\nexit 127\n' "$tool" >"$stubs/$tool"
      chmod +x "$stubs/$tool"
      if [ "$(PATH="$stubs:$PATH" command -v "$tool")" != "$stubs/$tool" ]; then
        echo "build-without-node: $tool is not shadowed, so a green run would prove nothing" >&2
        exit 1
      fi
    done
    PATH="$stubs:$PATH" just build lint

# The dashboard's own build. Same rule as the landing recipes below: it needs
# npm, so nothing reachable from `ci` or `check` may depend on it.
web-build:
    npm --prefix web ci
    npm --prefix web run build

# M7's one file to copy: the appliance daemon with the dashboard inside it.
# Run it *after* `just appliance`, which builds a `yantrad` without one over it.
appliance-embedded target=appliance_target: web-build
    cargo zigbuild --release --target {{target}} \
        -p yantrad --features embed-dashboard
    @ls -lh target/{{target}}/release/yantrad

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
appliance-size target=appliance_target: (appliance target)
    @ls -lh target/{{target}}/release/yantrad \
            target/{{target}}/release/yantra \
            target/{{target}}/release/yantra-agent

# A binary that is only cross-compiled cannot be run, so the other three numbers
# ADR-0004 owes M7 — idle RSS, idle CPU, CLI cold-start — are measured on the
# target this machine executes. musl rather than the host toolchain because
# mallocng is what the appliance links and it is most of the RSS. Whichever box
# Q15 picks, this is a floor and not its answer.
runtime_target := "x86_64-unknown-linux-musl"

# Three settings, all of them arguable, so they are named rather than inline.
# Four of `refresh::EVERY`'s 30 s cycles to settle; ten more to average CPU
# over, because a jiffy is 10 ms and a shorter window prices an idle daemon in
# single digits of them; enough CLI runs to see a spread rather than a number.
runtime_settle := "125"
runtime_window := "300"
runtime_samples := "50"

# `yantrad` refuses to start unless Tailscale tells it which addresses this
# machine holds (R-22), and on the machine that builds it 7717 is already bound
# by the developer's own. So it runs in a user + network namespace carrying this
# node's real addresses on `lo`: the refusal is answered by the real `tailscale`
# over its socket, which crosses the namespace, and the bind is a real one on a
# port nobody else holds. No root, and nothing of the daemon is stubbed.
appliance-runtime:
    #!/usr/bin/env bash
    set -euo pipefail
    # $EPOCHREALTIME below carries the locale's decimal separator.
    export LC_ALL=C
    cargo zigbuild --release --target {{runtime_target}} -p yantrad -p yantra
    release="$PWD/target/{{runtime_target}}/release"

    # An empty config is the floor: workspaces cost ssh, and what the appliance
    # will hold is not what this machine holds.
    config=$(mktemp -d)
    trap 'rm -rf "$config"' EXIT
    mkdir -p "$config/yantra/workspaces"

    XDG_CONFIG_HOME="$config" unshare --user --map-root-user --net -- bash -c '
      set -eu
      ip link set lo up
      for address in $(tailscale ip); do
        case $address in
          *:*) ip -6 addr add "$address/128" dev lo ;;
          *)   ip addr add "$address/32" dev lo ;;
        esac
      done
      exec "$0"' "$release/yantrad" &
    daemon=$!
    trap 'kill -TERM '"$daemon"' 2>/dev/null; rm -rf "$config"' EXIT

    sleep {{runtime_settle}}
    kill -0 "$daemon" 2>/dev/null || {
      echo "appliance-runtime: yantrad is not running, so there is nothing to measure" >&2
      exit 1
    }

    # Fields 16 and 17 are the reaped children, and leaving them out would price
    # a daemon whose whole idle workload is spawning `tailscale` at its own
    # bookkeeping. Reported either side of the sum, because the gap is the point.
    ticks=$(getconf CLK_TCK)
    cpu() { awk -v want="$1" '{print want == "self" ? $14 + $15 : $16 + $17}' "/proc/$daemon/stat"; }
    self_before=$(cpu self) children_before=$(cpu children)
    sleep {{runtime_window}}
    self_after=$(cpu self) children_after=$(cpu children)

    echo
    echo "yantrad, {{runtime_target}}, idle, {{runtime_settle}}s after start:"
    grep -E '^Vm(RSS|HWM)|^Rss' "/proc/$daemon/status"
    grep Pss_Anon "/proc/$daemon/smaps_rollup"
    awk -v s="$(( self_after - self_before ))" -v c="$(( children_after - children_before ))" \
        -v t="$ticks" -v w={{runtime_window}} \
      'BEGIN { printf "CPU\t%.3f%% of one core over %ds, of which %.3f%% is the processes it spawned\n",
                      (s + c) / t / w * 100, w, c / t / w * 100 }'

    # Cold is the binary's page cache evicted before every run —
    # posix_fadvise(DONTNEED), which needs no root and is what `dd iflag=nocache
    # count=0` does. Warm is the same loop without it, so the pair prices the read.
    spread() {
      sort -n | awk -v label="$1" '{ v[NR] = $1 }
        END { printf "%s\tn=%d  min %.1f  p50 %.1f  p90 %.1f  max %.1f ms\n",
                     label, NR, v[1]/1000, v[int(NR*0.5)]/1000, v[int(NR*0.9)]/1000, v[NR]/1000 }'
    }
    samples() {
      for _ in $(seq {{runtime_samples}}); do
        if [[ $1 == cold ]]; then
          dd if="$release/yantra" iflag=nocache count=0 of=/dev/null status=none
        fi
        local start=${EPOCHREALTIME/./}
        "$release/yantra" --version > /dev/null
        echo $(( ${EPOCHREALTIME/./} - start ))
      done
    }

    echo
    echo "yantra --version, {{runtime_target}}:"
    samples cold | spread cold
    samples warm | spread warm

# Install or update the appliance from the machine that builds it: nothing has
# ever been published (Y-037), so a copy is the release. What the box needs
# before the first one is docs/appliance.md's.
appliance-install host target=appliance_target:
    #!/usr/bin/env bash
    set -euo pipefail
    release="target/{{target}}/release"
    for binary in yantrad yantra yantra-agent; do
      [[ -x "$release/$binary" ]] || {
        echo "appliance-install: no $release/$binary — run \`just appliance {{target}}\` first" >&2
        exit 1
      }
    done

    ssh {{host}} "rm -rf {{appliance_stage}} && mkdir -p {{appliance_stage}}"
    scp "$release"/yantrad "$release"/yantra "$release"/yantra-agent \
        crates/yantrad/yantrad.service crates/yantra-agent/yantra-agent.service \
        {{host}}:{{appliance_stage}}/

    # Renamed rather than written through, and staged in the destination
    # directory because rename(2) cannot cross a filesystem — `install` and a
    # cross-filesystem `mv` both work and neither is atomic (docs/appliance.md).
    # `try-restart` leaves a first install's units stopped until that document's
    # one-time setup has been done.
    remote='set -eu
    for binary in yantrad yantra yantra-agent; do
      install -m 755 {{appliance_stage}}/$binary /usr/local/bin/$binary.new
      mv -f /usr/local/bin/$binary.new /usr/local/bin/$binary
    done
    install -m 644 {{appliance_stage}}/yantrad.service {{appliance_stage}}/yantra-agent.service \
        /etc/systemd/system/
    rm -rf {{appliance_stage}}
    systemctl daemon-reload
    systemctl try-restart yantrad.service yantra-agent.service'
    ssh -t {{host}} "sudo sh -c '$remote'"
