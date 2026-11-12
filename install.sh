#!/usr/bin/env bash
#
# Install or update Yantra on an always-on Linux box from a published release.
#
#     curl -fsSL <url>/install.sh | bash
#     wget -qO- <url>/install.sh | bash        # Debian 13 has no curl
#
# On a Mac it installs yantra-agent alone, as a LaunchAgent, with no root (Y-502):
#
#     curl -fsSL <url>/install.sh | YANTRA_DAEMON=<address>:7717 bash
#
# At a terminal it asks before it installs Tailscale, logs the box in, turns on
# HTTPS, starts the units and prints the dashboard's address (Y-384). With no
# terminal it asks nothing, enables nothing and ends by naming what is left.
# docs/appliance.md is the runbook around it.
#
# `--yes`, or YANTRA_YES=1, answers every question yes, with or without a
# terminal (Y-474). TS_AUTHKEY logs the box in with that key, read from stdin:
#
#     curl -fsSL <url>/install.sh | TS_AUTHKEY=tskey-auth-… bash -s -- --yes
#
# A run that answers also lets yantrad log in to this box, as the account that ran
# it (Y-598). YANTRA_ACCOUNT names the account for a run as root:
#
#     curl -fsSL <url>/install.sh | YANTRA_ACCOUNT=<account> bash -s -- --yes
#
# `--channel nightly` installs the build of the latest merge to main, and
# `--channel stable`, the default, the latest tagged release (Y-662). The choice
# is kept in /etc/yantra/channel, and later updates follow it. The release
# workflow signs each channel with its own key (Y-803).
#
#     curl -fsSL <url>/install.sh | bash -s -- --channel nightly
#
# `--agent` updates yantra-agent alone, on a Linux machine that joined a box
# (Y-713). It replaces the binary and its unit, keeps /etc/yantra/agent.env and
# restarts the agent. It installs no yantrad:
#
#     curl -fsSL <url>/install.sh | bash -s -- --agent
#
# `--uninstall` reverses it (Y-407):
#
#     curl -fsSL <url>/install.sh | bash -s -- --uninstall
#
# It always removes the services and the binaries. It asks, one at a time and
# default no, before it removes /etc/yantra, the yantra account, or the
# dashboard's Tailscale serve. `--yes` answers none of those: they stay no.

# bash runs a piped script as it reads it, and a Ctrl-C also kills the `curl`
# still writing it. The braces make bash read the whole file before it runs any.
{
set -euo pipefail

REPO=2002Bishwajeet/yantra
# ADR-0027 decision 4: release.yml's `sign` job signs SHA256SUMS with these keys
# (Y-803). A `v*` release takes the stable key, and `nightly` the nightly key.
STABLE_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKWmXvkfNo9r509vy22IcrOfGTrVf7WZeQG7Ol5wmmy3'
NIGHTLY_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE+Xh/af0VMj+KBHzPsyzOyQTcJHZtxtESP0FouO6kyv'
BIN_DIR=/usr/local/bin
AGENT_ENV=/etc/yantra/agent.env
DAEMON_ENV=/etc/yantra/daemon.env
CHANNEL_FILE=/etc/yantra/channel
INSTALLED=/var/lib/yantra/installed
PORT=7717
HTTPS_PORT=8443
# ADR-0042: `tailscale serve` proxies to yantrad's socket, where the kernel names the caller.
SOCKET=/run/yantra/yantrad.sock

fail() {
    echo "install: $*" >&2
    exit 1
}

# Y-612: run by yantra-update.service, this has RUNTIME_DIRECTORY. yantrad cannot
# read the journal, so the run writes how far it got there, and its stderr too.
# The journal still gets every line. A run at a terminal writes nothing here.
state=${RUNTIME_DIRECTORY:-}
work=
step() {
    [ -n "$state" ] || return 0
    printf 'step=%s\nversion=%s\narchive=%s\ntotal=%s\n' \
        "$1" "${VERSION:-}" "${archive:-}" "${total:-}" >"$state/status.new"
    mv -f "$state/status.new" "$state/status"
}
finish() {
    local status=$?
    if [ -n "$work" ]; then rm -rf "$work"; fi
    if [ -n "$state" ]; then
        if [ -n "${archive:-}" ]; then rm -f "$state/$archive" "$state/SHA256SUMS"; fi
        # tee must write the last line before the status names the failure.
        exec 2>&-
        wait "$teed" 2>/dev/null || true
        if [ "$status" -eq 0 ]; then step "done"; else step failed; fi
    fi
}
trap finish EXIT
if [ -n "$state" ]; then
    rm -f -- "$state"/*
    exec 2> >(tee -a "$state/said" >&2)
    teed=$!
    trap 'exit 143' TERM
    step resolving
fi

# What installs when nobody names a version. `/releases/latest` skips drafts and
# pre-releases, so a hyphenated `rc` tag can never install itself (ADR-0027 §4).
#
# What resolving gives up, said plainly: the VERSION and COMMIT this replaced
# were a person's choice in a reviewed commit, and the comment beside COMMIT
# recorded that v0.1.0's tag was moved once. SHA256SUMS still proves the archive
# arrived intact from the release it names. The signature on SHA256SUMS proves
# that this repository's release workflow built that release (verify_signature).
# It does not prove that a person read the code.
# Stable reads /releases/latest. Nightly reads the rolling `nightly` release,
# whose tag names no version, so the version is read off this target's archive.
latest_version() {
    local answer status tag path=latest
    [ "$channel" = nightly ] && path=tags/nightly
    answer=$(curl -sSL --proto '=https' --tlsv1.2 -w '\n%{http_code}' \
        -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/$REPO/releases/$path") ||
        fail "GitHub is unreachable, so no version was resolved and nothing was installed — name one with YANTRA_VERSION"
    status=${answer##*$'\n'}
    case "$status" in
    200) ;;
    403 | 429)
        # 60 requests an hour per IP, shared with everything behind it, and the
        # script sends no token (ADR-0027 §4).
        fail "GitHub answered $status: the rate limit for an unauthenticated call. Nothing was installed — retry later, or name a version with YANTRA_VERSION"
        ;;
    *) fail "GitHub answered $status for the $channel release — nothing was installed. Name a version with YANTRA_VERSION" ;;
    esac
    answer=${answer%$'\n'*}
    if [ "$channel" = nightly ]; then
        tag=$(printf '%s' "$answer" |
            grep -o "\"name\" *: *\"yantra-[^\"]*-$target\.tar\.gz\"" | head -n 1 |
            cut -d '"' -f 4 | sed -e 's/^yantra-//' -e "s/-$target\.tar\.gz\$//")
        [ -n "$tag" ] ||
            fail "the nightly release carries no archive for $target — nothing was installed"
    else
        tag=$(printf '%s' "$answer" |
            grep -o '"tag_name" *: *"[^"]*"' | head -n 1 | cut -d '"' -f 4)
        [ -n "$tag" ] ||
            fail "GitHub's release list named no tag_name — nothing was installed"
    fi
    printf '%s\n' "${tag#v}"
}

fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$1" "$2"; }

# ADR-0027 decision 4: a checksum proves the archive is whole, not who made it.
# $1 is the release's URL and $2 the folder that holds SHA256SUMS. The key
# follows the release, so a nightly signature never installs as stable.
verify_signature() {
    local signer=stable key=$STABLE_KEY
    case "$1" in */download/nightly) signer=nightly key=$NIGHTLY_KEY ;; esac
    command -v ssh-keygen >/dev/null 2>&1 ||
        fail "ssh-keygen is not installed, so the signature of SHA256SUMS cannot be checked — nothing was installed"
    fetch "$work/SHA256SUMS.sig" "$1/SHA256SUMS.sig" ||
        fail "v$VERSION carries no SHA256SUMS.sig, so nothing shows that the release workflow built it — nothing was installed"
    printf 'yantra-release namespaces="file" %s\n' "$key" >"$work/allowed_signers"
    ssh-keygen -Y verify -f "$work/allowed_signers" -I yantra-release -n file \
        -s "$work/SHA256SUMS.sig" <"$2/SHA256SUMS" >/dev/null 2>&1 ||
        fail "SHA256SUMS.sig is not the $signer key's signature of SHA256SUMS — nothing was installed"
}

# Y-502: a Mac takes yantra-agent alone, as a LaunchAgent in the login session of
# the account that runs this, so it needs no root. The label is join.sh's, so a
# Mac that joined gets this shape and a second run attaches.
mac() {
    local label=io.github.2002bishwajeet.yantra-agent
    local bin=$HOME/.local/bin/yantra-agent env=$HOME/.config/yantra/agent.env
    local plist=$HOME/Library/LaunchAgents/$label.plist uid domain tries=0
    uid=$(id -u)
    domain=gui/$uid
    [ "$uid" -ne 0 ] ||
        fail "run this as the account logged in at this Mac, not as root — nothing was installed"
    channel=stable
    while [ "$#" -gt 0 ]; do
        case "$1" in
        --yes) ;;
        --channel=*) channel=${1#--channel=} ;;
        --channel)
            channel=${2:-}
            [ "$#" -lt 2 ] || shift
            ;;
        --uninstall) fail "on a Mac, remove the agent by hand: launchctl bootout $domain/$label; rm -f $plist $bin" ;;
        *) fail "$1 is not an option on a Mac. The options are --yes and --channel stable." ;;
        esac
        shift
    done
    [ "$channel" = stable ] ||
        fail "a Mac installs the stable channel alone: nightly builds carry no macOS archive. Nothing was installed."
    for tool in curl tar shasum; do
        command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
    done
    case "$(uname -m)" in
    arm64) target=aarch64-apple-darwin ;;
    *) target=x86_64-apple-darwin ;;
    esac
    VERSION="${YANTRA_VERSION:-$(latest_version)}"
    archive="yantra-$VERSION-$target.tar.gz"
    work=$(mktemp -d)
    echo "install: yantra-agent v$VERSION, $target"

    local download="https://github.com/$REPO/releases/download/v$VERSION"
    fetch "$work/$archive" "$download/$archive"
    fetch "$work/SHA256SUMS" "$download/SHA256SUMS"
    verify_signature "$download" "$work"
    # shasum, because older macOS has no sha256sum.
    (cd "$work" && grep " $archive\$" SHA256SUMS | shasum -a 256 -c) ||
        fail "$archive does not match SHA256SUMS — nothing was installed"
    tar -C "$work" -xzf "$work/$archive"

    mkdir -p "${bin%/*}" "${env%/*}" "${plist%/*}" "$HOME/Library/Logs"
    install -m 755 "$work/yantra-$VERSION-$target/yantra-agent" "$bin.new"
    mv -f "$bin.new" "$bin"
    # ADR-0013 §4: an existing file is never rewritten.
    if [ -e "$env" ]; then
        echo "install: $env was already here and was left alone."
    else
        local daemon=${YANTRA_DAEMON:-} line="#YANTRA_DAEMON=100.x.x.x:$PORT"
        # join.sh's LaunchAgent holds the address itself and writes no agent.env.
        if [ -z "$daemon" ] && [ -e "$plist" ]; then
            daemon=$(plutil -extract EnvironmentVariables.YANTRA_DAEMON raw -o - "$plist" 2>/dev/null) || daemon=
            [ -z "$daemon" ] || echo "install: kept the daemon address $daemon from the LaunchAgent the join command wrote."
        fi
        [ -n "$daemon" ] && line="YANTRA_DAEMON=$daemon"
        cat >"$env" <<ENV
# The address of the machine running yantrad, and the agent's whole
# configuration (ADR-0013 §4). An address, never a MagicDNS name.
$line
ENV
    fi
    # launchd has no EnvironmentFile, so sh reads agent.env the way systemd does.
    cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key><array>
        <string>/bin/sh</string><string>-c</string><string>set -a; . "\$1"; exec "\$2"</string>
        <string>sh</string><string>$env</string><string>$bin</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardErrorPath</key><string>$HOME/Library/Logs/yantra-agent.log</string>
</dict>
</plist>
PLIST

    if ! grep -q '^YANTRA_DAEMON=' "$env"; then
        echo "install: $env names no daemon, so yantra-agent is not loaded. Add: YANTRA_DAEMON=<yantrad's address>:$PORT"
        echo "install: then load it: launchctl bootstrap $domain $plist"
        return 0
    fi
    launchctl bootout "$domain/$label" 2>/dev/null || true
    # bootout returns before launchd lets the label go, and a bootstrap then fails.
    until launchctl bootstrap "$domain" "$plist" 2>/dev/null; do
        tries=$((tries + 1))
        [ "$tries" -lt 10 ] || fail "launchctl did not load $plist. Load it by hand: launchctl bootstrap $domain $plist"
        sleep 1
    done
    echo "install: yantra-agent is running, and reports to $(sed -n 's/^YANTRA_DAEMON=//p' "$env" | tail -n 1)."
}

if [ "$(uname -s)" = Darwin ]; then
    mac "$@"
    exit 0
fi

if [ "$(id -u)" -eq 0 ]; then
    as_root() { "$@"; }
else
    command -v sudo >/dev/null 2>&1 ||
        fail "this needs root and there is no sudo on this box"
    as_root() { sudo "$@"; }
fi

# Debian 13 ships wget and no curl; the script itself then needs curl.
if ! command -v curl >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    echo "install: curl is missing, so apt-get installs it" >&2
    as_root apt-get update -qq || fail "apt-get update failed, so curl was not installed"
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates ||
        fail "apt-get could not install curl"
fi

for tool in curl tar sha256sum systemctl; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
done

[ "$(uname -s)" = Linux ] ||
    fail "$(uname -s) is not a target: releases are built for Linux and macOS"

case "$(uname -m)" in
aarch64 | arm64) target=aarch64-unknown-linux-musl ;;
x86_64 | amd64) target=x86_64-unknown-linux-musl ;;
*) fail "no release is built for $(uname -m)" ;;
esac

# `curl | bash` makes stdin the script, so answers come from the terminal. Every
# command that could read stdin at a terminal gets `</dev/tty`, or it would eat
# the rest of this file.
if { : </dev/tty; } 2>/dev/null; then
    interactive=yes
else
    interactive=no
fi

yes=no
if [ "${YANTRA_YES:-}" = 1 ]; then
    yes=yes
fi
uninstalling=no
agent_only=no
channel=
while [ "$#" -gt 0 ]; do
    case "$1" in
    --yes) yes=yes ;;
    --uninstall) uninstalling=yes ;;
    --agent) agent_only=yes ;;
    --channel=*) channel=${1#--channel=} ;;
    --channel)
        [ "$#" -ge 2 ] || fail "--channel needs stable or nightly"
        channel=$2
        shift
        ;;
    *) fail "$1 is not an option. The options are --yes, --channel stable|nightly, --agent and --uninstall." ;;
    esac
    shift
done
case "$channel" in
"" | stable | nightly) ;;
*) fail "$channel is not a channel. Name stable or nightly." ;;
esac
if [ "$agent_only" = yes ]; then
    [ "$uninstalling" = no ] || fail "--agent and --uninstall do not go together"
    [ -e "$AGENT_ENV" ] ||
        fail "$AGENT_ENV is missing, so there is no agent here to update. Run the join command on this machine"
fi
# A person names the channel; the unit never does, so it reads the one kept.
channel_named=$channel
if [ -z "$channel" ] && [ -e "$CHANNEL_FILE" ]; then
    channel=$(tr -d '[:space:]' <"$CHANNEL_FILE")
    case "$channel" in
    stable | nightly) ;;
    *) fail "$CHANNEL_FILE names no channel — nothing was installed. Write stable or nightly in it" ;;
    esac
fi
channel=${channel:-stable}

answering=no
if [ "$interactive" = yes ] || [ "$yes" = yes ]; then
    answering=yes
fi

# What a tailscale command reads: the terminal, or nothing when there is none.
if [ "$interactive" = yes ]; then
    tty=/dev/tty
else
    tty=/dev/null
fi

ask() {
    local reply
    if [ "$yes" = yes ]; then
        echo "install: $1 yes"
        return 0
    fi
    printf 'install: %s [Y/n] ' "$1" >/dev/tty
    # An empty line takes the default; ^D is not a yes.
    read -r reply </dev/tty || return 1
    case "$reply" in [Nn]*) return 1 ;; esac
}

# Like ask, but the default is no: an uninstall step must not delete a
# person's keys or secrets on a blank Enter.
ask_no() {
    local reply
    printf 'install: %s [y/N] ' "$1" >/dev/tty
    read -r reply </dev/tty || return 1
    case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# Reverses the install (Y-407). The services and the binaries always go;
# /etc/yantra, the yantra account and the dashboard's serve are each asked
# for, kept by default, and left alone with no terminal to ask.
uninstall() {
    local units=(yantrad.service yantra-agent.service yantra-update.path yantra-update.service)
    as_root systemctl stop "${units[@]}" 2>/dev/null || true
    as_root systemctl disable "${units[@]}" 2>/dev/null || true
    as_root rm -f /etc/systemd/system/yantrad.service /etc/systemd/system/yantra-agent.service \
        /etc/systemd/system/yantra-update.path /etc/systemd/system/yantra-update.service
    as_root systemctl daemon-reload
    as_root rm -f "$BIN_DIR/yantra" "$BIN_DIR/yantrad" "$BIN_DIR/yantra-agent" "$BIN_DIR/yantra-update" \
        "$BIN_DIR/yantra.prev" "$BIN_DIR/yantrad.prev" "$BIN_DIR/yantra-agent.prev"
    as_root rm -rf "${INSTALLED%/*}"

    local removed="the services, the units, the three binaries, the updater and the previous binaries" kept=""

    if [ "$interactive" = yes ] &&
        ask_no "Remove /etc/yantra? It holds the ntfy token and the GitHub token."; then
        as_root rm -rf /etc/yantra
        removed="$removed, /etc/yantra"
    else
        kept="/etc/yantra"
    fi

    if [ "$interactive" = yes ] &&
        ask_no "Remove the yantra account and /home/yantra? It holds the SSH key, the SSH config and the workspaces."; then
        if as_root userdel -r yantra; then
            removed="$removed, the yantra account and /home/yantra"
        else
            echo "install: could not remove the yantra account. It is kept."
            kept="${kept:+$kept, }the yantra account and /home/yantra"
        fi
    else
        kept="${kept:+$kept, }the yantra account and /home/yantra"
    fi

    if command -v tailscale >/dev/null 2>&1 && [ "$interactive" = yes ] &&
        ask_no "Turn off the Tailscale serve on port $HTTPS_PORT?"; then
        if as_root tailscale serve --https="$HTTPS_PORT" off; then
            removed="$removed, the Tailscale serve on port $HTTPS_PORT"
        else
            echo "install: could not turn off the Tailscale serve on port $HTTPS_PORT. It is kept."
            kept="${kept:+$kept, }the Tailscale serve on port $HTTPS_PORT"
        fi
    else
        kept="${kept:+$kept, }the Tailscale serve on port $HTTPS_PORT"
    fi

    echo "install: removed: $removed."
    if [ "$interactive" != yes ]; then
        echo "install: no terminal, so nothing above was asked."
    fi
    if [ -n "$kept" ]; then
        echo "install: kept: $kept."
        echo "install: run this script again and it picks up where it left off, for what it kept."
    fi
}

if [ "$uninstalling" = yes ]; then
    uninstall
    exit 0
fi

# The landing page's mark, traced from its PNG into braille. A terminal that is not
# UTF-8 would draw boxes, so it gets the wordmark alone. Drawn at a terminal only.
mark() {
    local on='' off=''
    if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
        on=$'\033[38;5;208m' off=$'\033[0m'
    fi
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *[Uu][Tt][Ff]-8* | *[Uu][Tt][Ff]8*)
        printf '%s' "$on"
        cat <<'MARK'

                  ⢠⡄
                  ⣸⣇
              ⢀⣤⣰⣦⣿⣿⣴⡆⣤⡀
            ⣤⣤⣿⠿⣿⣿⣾⢷⣿⣿⠻⣿⣤⣤
          ⢠⣲⡿⠋⡶⣶⣶⣾⣷⣽⣷⣶⢶⣶⠙⢿⣖⡄
          ⣧⣿⢧ ⣯⡿⣯⣷⣾⣷⣾⣽⢿⣼⢠⡾⣿⡼
      ⣀⣀⣤⣴⢿⣹⡟⠖⣿⣹⣿⢏⣾⣷⡙⣿⣏⣿⠺⢻⣏⣿⣦⣤⣀⣀
      ⠉⠉⠛⠻⣿⢹⣷⠦⣿⡹⣿⣾⣻⣟⣷⣿⢏⣿⢶⣽⣏⣿⠟⠛⠉⠉
         ⢀⣟⣿⡚ ⡟⣷⣟⣟⢿⡿⣛⣻⣾⣻⠘⢓⣿⢳
          ⠘⠽⣷⣄⠛⠓⢛⣻⣟⢻⣟⡛⠚⠛⣠⣾⠿⠃
            ⠛⠛⣿⣦⣿⡿⢶⡾⢿⣿⣴⣿⠛⠛
              ⠘⠛⠹⠝⣿⣿⠫⠏⠛⠁
                  ⢹⡏
                  ⠘⠃

             Yantra  यन्त्र
MARK
        ;;
    *) printf '%s\n                YANTRA\n' "$on" ;;
    esac
    printf '%s\n' "$off"
}

if [ "$agent_only" = yes ]; then
    echo "install: this updates yantra-agent alone, and keeps $AGENT_ENV."
else
    if [ "$interactive" = yes ]; then
        mark
    fi

    echo "install: this installs Yantra — three binaries, its updater, four systemd units and a yantra account."
    echo "install: every device you use with Yantra must be on one tailnet, logged in to the same Tailscale account."
    if [ "$interactive" = yes ]; then
        echo "install: it asks before it installs Tailscale or turns on HTTPS, then starts the dashboard and prints its address."
    fi
fi

# `MAJOR MINOR PATCH RANK STAMP`, so semver's order is a numeric sort: a
# nightly (rank 0) sorts below the release of its own number (rank 1).
order() {
    local core=${1%%-*} pre='' stamp=0 rank=1
    case "$1" in *-*) pre=${1#*-} rank=0 ;; esac
    case "$pre" in nightly.*)
        stamp=${pre#nightly.}
        stamp=${stamp%%.*}
        ;;
    esac
    case "$stamp" in '' | *[!0-9]*) stamp=0 ;; esac
    local IFS=.
    # shellcheck disable=SC2086
    set -- $core
    printf '%d %d %d %d %d\n' "${1:-0}" "${2:-0}" "${3:-0}" "$rank" "$stamp"
}

# Whether $1 sorts below $2.
older() {
    local a b
    a=$(order "$1")
    b=$(order "$2")
    [ "$a" != "$b" ] && [ "$(printf '%s\n%s\n' "$a" "$b" | sort -k1,1n -k2,2n -k3,3n -k4,4n -k5,5n | head -n 1)" = "$a" ]
}

VERSION="${YANTRA_VERSION:-$(latest_version)}"

# Y-662: the unit installs what a channel names, and the daemon's account can
# switch the channel. So the unit refuses to go back a version; only a person
# running this script does that.
if [ -n "$state" ] && [ -r "$INSTALLED" ]; then
    installed=$(tr -d '[:space:]' <"$INSTALLED")
    if [ -n "$installed" ] && older "$VERSION" "$installed"; then
        fail "the $channel release v$VERSION is older than v$installed, which is installed — nothing was installed. To go back, run as root: yantra-update --channel $channel"
    fi
fi

archive="yantra-$VERSION-$target.tar.gz"
work=$(mktemp -d)
# The unit downloads where yantrad can count the bytes received.
here=${state:-$work}

echo "install: yantra v$VERSION, $target, $channel"

download="https://github.com/$REPO/releases/download/v$VERSION"
if [ "$channel" = nightly ] && [ -z "${YANTRA_VERSION:-}" ]; then
    download="https://github.com/$REPO/releases/download/nightly"
fi
total=
if [ -n "$state" ]; then
    # Only for the progress, so a host that names no length costs nothing.
    total=$(curl -fsIL --proto '=https' --tlsv1.2 --max-time 30 "$download/$archive" |
        tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }') || total=
fi
step downloading
fetch "$here/$archive" "$download/$archive"
fetch "$here/SHA256SUMS" "$download/SHA256SUMS"

# A mismatch stops here rather than retrying or re-fetching: what produces one is
# a corrupted download or a substituted archive, and neither is repaired by
# trying again.
step verifying
verify_signature "$download" "$here"
(cd "$here" && sha256sum -c --ignore-missing SHA256SUMS) ||
    fail "$archive does not match SHA256SUMS — nothing was installed"

step installing
tar -C "$work" -xzf "$here/$archive"
staged="$work/yantra-$VERSION-$target"

# The units ride in the archive, so SHA256SUMS covers the files that decide
# what runs as root (Y-365). Releases before v0.2.0 carry none, and a stat error
# would be a poor way to learn that.
[ -e "$staged/yantrad.service" ] ||
    fail "v$VERSION carries no units, so it predates them moving into the archive — install v0.2.0 or later"

# The updater and its units ride in the archive too, since v0.4.0
# (Y-368). An older release installs without them and cannot update itself.
if [ -e "$staged/install.sh" ] && [ -e "$staged/yantra-update.service" ]; then
    updates=yes
else
    updates=no
fi

# Y-713: a machine that joined a box takes the agent alone. join.sh leaves an
# installed agent alone, and a second yantrad there would be a second appliance.
if [ "$agent_only" = yes ]; then
    as_root install -m 755 "$staged/yantra-agent" "$BIN_DIR/yantra-agent.new"
    as_root mv -f "$BIN_DIR/yantra-agent.new" "$BIN_DIR/yantra-agent"
    as_root install -m 644 "$staged/yantra-agent.service" /etc/systemd/system/
    as_root systemctl daemon-reload
    as_root systemctl restart yantra-agent.service
    echo "install: yantra-agent v$VERSION is in $BIN_DIR, and yantra-agent.service restarted."
    exit 0
fi

# yantrad reaches this box over ssh too (ADR-0009). It logs in to the person's account,
# where the sessions are; `yantra` holds the fleet's key and must never get a shell.
authorise_self() {
    local account machine=${name%%.*} said key
    # On this box the join goes on the socket: yantrad refuses this box's own address (ADR-0042).
    local join="curl -fsSL --unix-socket $SOCKET http://yantra/join | sh"
    account=${YANTRA_ACCOUNT:-${SUDO_USER:-$(id -un)}}

    if [ -z "$machine" ] || [ "$account" = root ] || [ "$account" = yantra ] ||
        ! id -- "$account" >/dev/null 2>&1; then
        echo "install: yantrad needs an account to log in to here, and this run has none to name."
        echo "install: run this here, as that account: $join"
        return 0
    fi

    # The full path, because sudo's secure_path omits it.
    if ! said=$(as_root sudo -Hu yantra "$BIN_DIR/yantra" ssh-identity \
        --machine "$machine" --user "$account" 2>&1 >/dev/null </dev/null); then
        echo "install: no key was placed for $account. $said"
        echo "install: once that is settled, run this here, as that account: $join"
        return 0
    fi

    if ! key=$(as_root cat /home/yantra/.ssh/id_yantra.pub) ||
        ! as_root sudo -Hu "$account" sh -s -- "$key" <<'PLACE'; then
set -e
umask 077
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
keys=$HOME/.ssh/authorized_keys
if [ ! -f "$keys" ] || ! grep -qxF -- "$1" "$keys"; then
    # A file that ends mid-line would join the key onto its last entry.
    if [ -s "$keys" ] && [ -n "$(tail -c 1 "$keys")" ]; then
        printf '\n' >>"$keys"
    fi
    printf '%s\n' "$1" >>"$keys"
    chmod 600 "$keys"
    if command -v restorecon >/dev/null 2>&1; then
        restorecon -R "$HOME/.ssh" 2>/dev/null || true
    fi
fi
PLACE
        echo "install: could not place the key for $account. Run this here, as that account: $join"
        return 0
    fi

    # `timeout`, because a Tailscale SSH check policy holds a login open for a browser.
    if as_root timeout 30 sudo -Hu yantra ssh -o BatchMode=yes -o ConnectTimeout=5 \
        -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null \
        -- "$machine" true </dev/null >/dev/null 2>&1; then
        echo "install: yantrad logs in here as $account."
    else
        echo "install: the key is in place, but yantrad could not log in here as $account."
        echo "install: sshd must run here. The dashboard's Check says why the login failed."
    fi
}

up() { command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; }
serving() { as_root tailscale serve status --json 2>/dev/null | grep -q "\"$HTTPS_PORT\""; }
# A serve this script set up before ADR-0042, which proxied to the tailnet address.
serving_tcp() {
    as_root tailscale serve status --json 2>/dev/null | tr -d ' \t\n' |
        grep -q ":$HTTPS_PORT\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://[^\"]*:$PORT\""
}

# After the checksum, so a bad archive leaves the box as it was. An interactive
# login joins the box untagged, which superseded Q17 (Y-384).
if [ "$answering" = yes ]; then
    question=
    if ! command -v tailscale >/dev/null 2>&1; then
        question="Install Tailscale, log this box in and turn on HTTPS?"
    elif ! up; then
        question="Log this box in to Tailscale and turn on HTTPS?"
    elif ! serving; then
        question="Turn on HTTPS for the dashboard?"
    fi
    if [ -n "$question" ]; then
        echo "install: HTTPS puts this machine's name in a public certificate log that anyone can read."
        if ask "$question"; then
            if ! command -v tailscale >/dev/null 2>&1; then
                curl -fsSL --proto '=https' --tlsv1.2 https://tailscale.com/install.sh | sh ||
                    fail "Tailscale's installer failed — nothing of Yantra was installed"
            fi
            if ! up; then
                if [ -n "${TS_AUTHKEY:-}" ]; then
                    # Through stdin, because sudo logs its command line to the journal.
                    printf '%s' "$TS_AUTHKEY" | as_root tailscale up --auth-key=file:/dev/stdin ||
                        fail "tailscale up did not finish — nothing of Yantra was installed"
                else
                    echo "install: tailscale prints a URL. Open it and log in with the account your other devices use."
                    as_root tailscale up <"$tty" ||
                        fail "tailscale up did not finish — nothing of Yantra was installed"
                fi
                echo "install: turn off key expiry for this box, or it leaves the tailnet when its key expires:"
                echo "install: admin console → Machines → this box's menu → Disable key expiry."
            fi
            # `serve` blocks on that link until HTTPS is on. Run as root, a Ctrl-C
            # there reaches this script too, and would end it before Yantra installs.
            trap 'echo' INT
            echo "install: on a tailnet that never had HTTPS, tailscale prints a link to turn it on. Ctrl-C skips HTTPS."
            # With no terminal nobody is there to Ctrl-C a serve that waits on its link.
            limit=()
            [ "$interactive" = yes ] || limit=(timeout 120)
            if ! as_root "${limit[@]}" tailscale serve --bg --https="$HTTPS_PORT" "unix:$SOCKET" <"$tty"; then
                echo "install: tailscale serve failed, so the dashboard is on plain HTTP."
            fi
            trap - INT
        fi
    fi
fi

# The one configuration an update changes (ADR-0042): the owner turned this serve
# on, and its old target now gets 403 on every write.
if up && serving_tcp; then
    if as_root timeout 30 tailscale serve --bg --https="$HTTPS_PORT" "unix:$SOCKET" </dev/null; then
        echo "install: the Tailscale serve on port $HTTPS_PORT now proxies to $SOCKET."
    else
        echo "install: could not point the Tailscale serve on port $HTTPS_PORT at $SOCKET, so writes through it get 403."
        echo "install: run: sudo tailscale serve --bg --https=$HTTPS_PORT unix:$SOCKET"
    fi
fi

# The units name this account, and its home is where the workspace files and the
# ssh ControlPath land.
id yantra >/dev/null 2>&1 ||
    as_root useradd --system --create-home --home-dir /home/yantra --shell /usr/sbin/nologin yantra

# Renamed rather than written through, and staged in the destination directory
# because rename(2) cannot cross a filesystem — a running binary answers ETXTBSY
# to a write, and `install` over it is not atomic (Y-145, docs/appliance.md).
as_root install -d "$BIN_DIR"
for binary in yantrad yantra yantra-agent; do
    as_root install -m 755 "$staged/$binary" "$BIN_DIR/$binary.new"
    # ADR-0027 §6: one generation back, for a rollback with no network. A run
    # that installs what is already there must not replace it with a copy of now.
    if [ -e "$BIN_DIR/$binary" ] && ! cmp -s "$staged/$binary" "$BIN_DIR/$binary"; then
        as_root cp -p "$BIN_DIR/$binary" "$BIN_DIR/$binary.prev"
    fi
    as_root mv -f "$BIN_DIR/$binary.new" "$BIN_DIR/$binary"
done
as_root install -d -m 755 "${INSTALLED%/*}"
printf '%s\n' "$VERSION" | as_root tee "$INSTALLED.new" >/dev/null
as_root mv -f "$INSTALLED.new" "$INSTALLED"

# Y-662: yantrad's account rewrites this file in place from Settings, and the
# unit reads it. /etc/yantra is root's, so that account cannot swap it for a link.
as_root install -d /etc/yantra
if [ -n "$channel_named" ] || [ ! -e "$CHANNEL_FILE" ]; then
    printf '%s\n' "$channel" | as_root tee "$CHANNEL_FILE" >/dev/null
fi
as_root chown yantra:yantra "$CHANNEL_FILE"
as_root chmod 644 "$CHANNEL_FILE"

# Y-612: the unit keeps a failed run's status, so a recovery at a terminal
# clears it, or About reports that failure beside the version installed here.
if [ -z "$state" ] && [ -d /run/yantra-update ]; then
    as_root rm -f /run/yantra-update/status /run/yantra-update/said
fi

as_root install -m 644 "$staged/yantrad.service" "$staged/yantra-agent.service" /etc/systemd/system/
if [ "$updates" = yes ]; then
    # The archive's copy, because a piped run has no file of its own and
    # SHA256SUMS covers this one. Renamed, because during an update the old
    # copy is the script bash is still reading.
    as_root install -m 755 "$staged/install.sh" "$BIN_DIR/yantra-update.new"
    as_root mv -f "$BIN_DIR/yantra-update.new" "$BIN_DIR/yantra-update"
    as_root install -m 644 "$staged/yantra-update.path" "$staged/yantra-update.service" /etc/systemd/system/
fi
as_root systemctl daemon-reload

address=
if [ "$answering" = yes ] && up; then
    ip=$(tailscale ip -4 2>/dev/null | head -n 1) || true
    if [ -n "$ip" ]; then
        address="$ip:$PORT"
    fi
fi

# The installer provisions and the updater touches no configuration (D2 §1): an
# existing file is never rewritten, and only this box's own address is written.
if [ -e "$AGENT_ENV" ]; then
    env_step="$AGENT_ENV was already here and was left alone."
else
    daemon_line="#YANTRA_DAEMON=100.x.x.x:$PORT"
    [ -n "$address" ] && daemon_line="YANTRA_DAEMON=$address"
    as_root install -d /etc/yantra
    as_root tee "$AGENT_ENV" >/dev/null <<ENV
# The address of the machine running yantrad, and the agent's whole
# configuration (ADR-0013 §4). An address, never a MagicDNS name.
$daemon_line
ENV
    as_root chmod 644 "$AGENT_ENV"
    env_step="Set YANTRA_DAEMON in $AGENT_ENV — what is there now is a placeholder."
fi

# ADR-0021: the daemon's own environment file, holding the ntfy relay. It is
# created empty and never with a value, and it is the one file here the daemon's
# account may rewrite — `/settings` in the browser writes through this account,
# while systemd reads the file as root. 0600 because the token is in plain text.
if [ ! -e "$DAEMON_ENV" ]; then
    as_root install -d /etc/yantra
    as_root tee "$DAEMON_ENV" >/dev/null <<'ENV'
# The ntfy relay yantrad publishes to (ADR-0021). `yantra relay <url>` writes
# this file, and so does /settings in the dashboard.
#YANTRA_NTFY_URL=https://ntfy.sh/<a-topic-nobody-guesses>
#YANTRA_NTFY_TOKEN=

# The GitHub OAuth App's client id (ADR-0023). The release build bakes one in;
# set this only to override it, for example a self-built binary with none.
#YANTRA_GITHUB_CLIENT_ID=
ENV
    as_root chown yantra:yantra "$DAEMON_ENV"
    as_root chmod 600 "$DAEMON_ENV"
fi

# ADR-0044, amended 2026-11-12: a box domain-setup.sh named before the passkey has no
# YANTRA_ORIGIN, so its passkeys would belong to the MagicDNS name the owner never opens.
# $1 is the daemon's environment file and $2 the Caddyfile domain-setup.sh wrote.
name_the_origin() {
    [ -e "$1" ] && [ -e "$2" ] && grep -qF 'unix//run/yantra/yantrad.sock' "$2" || return 0
    as_root grep -q '^YANTRA_ORIGIN=' "$1" && return 0
    local domain
    domain=$(sed -n 's/^https:\/\/\([A-Za-z0-9.-]*\) {$/\1/p' "$2" | head -n 1)
    [ -n "$domain" ] || return 0
    [ -z "$(as_root tail -c 1 "$1")" ] || echo | as_root tee -a "$1" >/dev/null
    echo "YANTRA_ORIGIN=https://$domain" | as_root tee -a "$1" >/dev/null
    echo "install: passkeys now belong to https://$domain, the name domain-setup.sh gave this box."
}
name_the_origin "$DAEMON_ENV" /etc/caddy/Caddyfile

# Y-777: Caddy's admin API answers every account on this box at 127.0.0.1:2019. An account that
# changes Caddy's config there speaks to the socket as the proxy yantrad trusts (ADR-0042).
# $1 is the Caddyfile. Caddy reloads through that API, so the change needs a restart.
close_the_admin_api() {
    [ -e "$1" ] && as_root grep -qF 'unix//run/yantra/yantrad.sock' "$1" || return 0
    as_root grep -qE '^[[:space:]]*admin[[:space:]]+off([[:space:]]|$)' "$1" && return 0
    if as_root grep -qE '^[[:space:]]*admin([[:space:]]|$)' "$1"; then
        echo "install: $1 sets Caddy's admin API itself, so it is not changed. Any account on this box can use that API to act as yantrad's proxy; \"admin off\" closes it."
        return 0
    fi
    # The first line that holds only "{" opens the global block. A snippet can stand before the
    # block, and a comment or a CR can follow the brace.
    local closed adapted
    closed=$(as_root cat "$1" | awk '
        { line[NR] = $0 }
        !at && /^[ \t]*[{]([ \t]+#.*)?[ \t\r]*$/ { at = NR }
        END {
            if (!at) printf "{\n    admin off\n}\n\n"
            for (i = 1; i <= NR; i++) {
                print line[i]
                if (i == at) print "    admin off" (line[i] ~ /\r$/ ? "\r" : "")
            }
        }')
    # Caddy judges a copy before the file changes: a file that Caddy refuses stops the proxy.
    # The copy is beside the file for its import paths, and cp -p gives it the same owner and mode.
    as_root cp -p "$1" "$1.admin-off"
    printf '%s\n' "$closed" | as_root tee "$1.admin-off" >/dev/null
    adapted=$(as_root caddy adapt --config "$1.admin-off" --adapter caddyfile 2>/dev/null) || true
    as_root rm -f "$1.admin-off"
    case "$adapted" in
    *'"admin":{"disabled":true'*) ;;
    *)
        echo "install: $1 is not changed. \"caddy adapt\" did not read a copy with \"admin off\" added as a config with the admin API off. Any account on this box can use that API to act as yantrad's proxy. Put \"admin off\" in the global options block, then run: sudo systemctl restart caddy.service"
        return 0
        ;;
    esac
    printf '%s\n' "$closed" | as_root tee "$1" >/dev/null
    if as_root systemctl try-restart caddy.service; then
        echo "install: Caddy's admin API is now off in $1. Any account on this box could use it to act as yantrad's proxy."
    else
        echo "install: $1 now says \"admin off\", but Caddy did not restart. Run: sudo systemctl restart caddy.service"
    fi
}
close_the_admin_api /etc/caddy/Caddyfile

if [ -n "$address" ]; then
    running=no
    if systemctl is-active --quiet yantrad.service ||
        systemctl is-active --quiet yantra-agent.service; then
        running=yes
    fi
    as_root systemctl enable --now yantrad.service
    if [ "$updates" = yes ]; then
        as_root systemctl enable --now yantra-update.path
    fi
    if grep -q '^YANTRA_DAEMON=' "$AGENT_ENV"; then
        as_root systemctl enable --now yantra-agent.service
    else
        echo "install: $AGENT_ENV names no daemon, so yantra-agent is not started. Add: YANTRA_DAEMON=$address"
    fi
    # ADR-0027 §5 warns against an unattended restart, so only a person at a
    # terminal is asked; --yes with no terminal leaves the running units alone.
    if [ "$running" = yes ]; then
        if [ "$interactive" = yes ] && ask "Restart yantrad and yantra-agent now?"; then
            as_root systemctl try-restart yantrad.service yantra-agent.service
        else
            echo "install: the units still run the version before v$VERSION. To run it: sudo systemctl try-restart yantrad.service yantra-agent.service"
        fi
    fi

    # The unit's RestartSec is 10 s, so this outlasts two refusals while
    # tailscaled is still learning its address.
    ready=no
    deadline=$((SECONDS + 30))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if curl -fsS --max-time 2 -o /dev/null "http://$address/healthz" 2>/dev/null; then
            ready=yes
            break
        fi
        sleep 1
    done
    [ "$ready" = yes ] ||
        fail "yantrad did not answer on $address in 30 s. Read why: journalctl -u yantrad -n 20 --no-pager"

    # Self comes before Peer in the status JSON, so the first DNSName is this box's.
    name=$(tailscale status --json | grep -o '"DNSName": *"[^"]*"' | head -n 1 | cut -d '"' -f 4) || true
    if [ -n "$name" ] && serving; then
        url="https://${name%.}:$HTTPS_PORT"
    else
        url="http://$address"
    fi
    # Only here, because the updater never answers and touches no configuration (D2 §1).
    authorise_self
    if [ "$interactive" = yes ] && command -v qrencode >/dev/null; then
        qrencode -t ansiutf8 "$url" </dev/null || true
    fi
    echo "install: open the dashboard at $url"
    exit 0
fi

if ! command -v tailscale >/dev/null 2>&1; then
    tailscale_state="not installed"
    tailscale_step="Install Tailscale and enrol this box. yantrad refuses to start until it can name this machine's addresses."
elif up; then
    tailscale_state="up"
    tailscale_step="Tailscale is up, so nothing is needed here."
else
    tailscale_state="installed, not up"
    tailscale_step="Enrol this box: \`sudo tailscale up\`. yantrad refuses to start until it can name this machine's addresses."
fi

# An update runs here too, with no terminal, and its journal must not say the
# units are off when they are on.
if systemctl is-enabled --quiet yantrad.service 2>/dev/null; then
    # A box that came from a release with no updater has the path unit off.
    [ "$updates" = yes ] && as_root systemctl enable --now yantra-update.path
    echo "install: v$VERSION is in $BIN_DIR, and yantrad.service is enabled."
    echo "install: yantra-update.service restarts what runs. By hand: sudo systemctl try-restart yantrad.service yantra-agent.service"
    exit 0
fi

start="yantrad.service yantra-agent.service"
[ "$updates" = yes ] && start="$start yantra-update.path"

cat <<REPORT

install: yantrad, yantra and yantra-agent are in $BIN_DIR; the units are in
install: /etc/systemd/system and none is enabled. Tailscale is $tailscale_state.

What is left, none of which this script does for you:

  1. $env_step
  2. $tailscale_step
  3. Start them: \`sudo systemctl enable --now $start\`
  4. Add each machine. In a terminal on it, as the account Yantra is to log in as:
     \`curl -fsSL http://<this box's tailnet address>:7717/join | sh\`. The daemon
     makes its ssh key the first time a machine joins.

Run this script again at a terminal and it does 2, starts yantrad and prints
the dashboard's address. Step 1 stays yours: it never rewrites an agent.env
that exists, and yantra-agent starts once that file names the daemon.
REPORT
}
