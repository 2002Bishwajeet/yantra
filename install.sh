#!/usr/bin/env bash
#
# Install or update Yantra on an always-on Linux box from a published release.
#
#     curl -fsSL <url>/install.sh | bash
#
# At a terminal it asks before it installs Tailscale, logs the box in, turns on
# HTTPS, starts both units and prints the dashboard's address (Y-384). With no
# terminal it asks nothing, enables nothing and ends by naming what is left.
# docs/appliance.md is the runbook around it.
#
# `--uninstall` reverses it (Y-407):
#
#     curl -fsSL <url>/install.sh | bash -s -- --uninstall
#
# It always removes the services and the binaries. It asks, one at a time and
# default no, before it removes /etc/yantra, the yantra account, or the
# dashboard's Tailscale serve.
set -euo pipefail

REPO=2002Bishwajeet/yantra
BIN_DIR=/usr/local/bin
AGENT_ENV=/etc/yantra/agent.env
DAEMON_ENV=/etc/yantra/daemon.env
PORT=7717
HTTPS_PORT=8443

fail() {
    echo "install: $*" >&2
    exit 1
}

if [ "$(id -u)" -eq 0 ]; then
    as_root() { "$@"; }
else
    command -v sudo >/dev/null 2>&1 ||
        fail "this needs root and there is no sudo on this box"
    as_root() { sudo "$@"; }
fi

for tool in curl tar sha256sum systemctl; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
done

[ "$(uname -s)" = Linux ] ||
    fail "$(uname -s) is not a target: yantrad and yantra are Linux-only and macOS ships the agent alone"

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

ask() {
    local reply
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
    as_root systemctl stop yantrad.service yantra-agent.service 2>/dev/null || true
    as_root systemctl disable yantrad.service yantra-agent.service 2>/dev/null || true
    as_root rm -f /etc/systemd/system/yantrad.service /etc/systemd/system/yantra-agent.service
    as_root systemctl daemon-reload
    as_root rm -f "$BIN_DIR/yantra" "$BIN_DIR/yantrad" "$BIN_DIR/yantra-agent"

    local removed="the services, the units and the three binaries" kept=""

    if [ "$interactive" = yes ] &&
        ask_no "Remove /etc/yantra? It holds the ntfy token and the GitHub token."; then
        as_root rm -rf /etc/yantra
        removed="$removed, /etc/yantra"
    else
        kept="/etc/yantra"
    fi

    if [ "$interactive" = yes ] &&
        ask_no "Remove the yantra account and /home/yantra? It holds the SSH key, the SSH config and the workspaces."; then
        as_root userdel -r yantra 2>/dev/null || true
        removed="$removed, the yantra account and /home/yantra"
    else
        kept="${kept:+$kept, }the yantra account and /home/yantra"
    fi

    if command -v tailscale >/dev/null 2>&1 && [ "$interactive" = yes ] &&
        ask_no "Turn off the Tailscale serve on port $HTTPS_PORT?"; then
        as_root tailscale serve --https="$HTTPS_PORT" off 2>/dev/null || true
        removed="$removed, the Tailscale serve on port $HTTPS_PORT"
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

if [ "${1:-}" = --uninstall ]; then
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

if [ "$interactive" = yes ]; then
    mark
fi

echo "install: this installs Yantra — three binaries, two systemd units and a yantra account."
echo "install: every device you use with Yantra must be on one tailnet, logged in to the same Tailscale account."
if [ "$interactive" = yes ]; then
    echo "install: it asks before it installs Tailscale or turns on HTTPS, then starts the dashboard and prints its address."
fi

# What installs when nobody names a version. `/releases/latest` skips drafts and
# pre-releases, so a hyphenated `rc` tag can never install itself (ADR-0027 §4).
#
# What resolving gives up, said plainly: the VERSION and COMMIT this replaced
# were a person's choice in a reviewed commit, and the comment beside COMMIT
# recorded that v0.1.0's tag was moved once. SHA256SUMS still proves the archive
# arrived intact from the release it names. Nothing here proves that release is
# the one the owner meant — what is left is trust in the repository and in
# whoever can publish to it.
latest_version() {
    local answer status tag
    answer=$(curl -sSL --proto '=https' --tlsv1.2 -w '\n%{http_code}' \
        -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/$REPO/releases/latest") ||
        fail "GitHub is unreachable, so no version was resolved and nothing was installed — name one with YANTRA_VERSION"
    status=${answer##*$'\n'}
    case "$status" in
    200) ;;
    403 | 429)
        # 60 requests an hour per IP, shared with everything behind it, and the
        # script sends no token (ADR-0027 §4).
        fail "GitHub answered $status: the rate limit for an unauthenticated call. Nothing was installed — retry later, or name a version with YANTRA_VERSION"
        ;;
    *) fail "GitHub answered $status for the release list — nothing was installed. Name a version with YANTRA_VERSION" ;;
    esac
    tag=$(printf '%s' "${answer%$'\n'*}" |
        grep -o '"tag_name" *: *"[^"]*"' | head -n 1 | cut -d '"' -f 4)
    [ -n "$tag" ] ||
        fail "GitHub's release list named no tag_name — nothing was installed"
    printf '%s\n' "${tag#v}"
}

VERSION="${YANTRA_VERSION:-$(latest_version)}"

archive="yantra-$VERSION-$target.tar.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "install: yantra v$VERSION, $target"

fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$1" "$2"; }

download="https://github.com/$REPO/releases/download/v$VERSION"
fetch "$work/$archive" "$download/$archive"
fetch "$work/SHA256SUMS" "$download/SHA256SUMS"

# A mismatch stops here rather than retrying or re-fetching: what produces one is
# a corrupted download or a substituted archive, and neither is repaired by
# trying again.
(cd "$work" && sha256sum -c --ignore-missing SHA256SUMS) ||
    fail "$archive does not match SHA256SUMS — nothing was installed"

tar -C "$work" -xzf "$work/$archive"
staged="$work/yantra-$VERSION-$target"

# The units ride in the archive, so SHA256SUMS covers the two files that decide
# what runs as root (Y-365). Releases before v0.2.0 carry none, and a stat error
# would be a poor way to learn that.
[ -e "$staged/yantrad.service" ] ||
    fail "v$VERSION carries no units, so it predates them moving into the archive — install v0.2.0 or later"

up() { command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; }
serving() { as_root tailscale serve status --json 2>/dev/null | grep -q "\"$HTTPS_PORT\""; }

# After the checksum, so a bad archive leaves the box as it was. An interactive
# login joins the box untagged, which superseded Q17 (Y-384).
if [ "$interactive" = yes ]; then
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
                echo "install: tailscale prints a URL. Open it and log in with the account your other devices use."
                as_root tailscale up </dev/tty ||
                    fail "tailscale up did not finish — nothing of Yantra was installed"
                echo "install: turn off key expiry for this box, or it leaves the tailnet when its key expires:"
                echo "install: admin console → Machines → this box's menu → Disable key expiry."
            fi
            # `serve` blocks on that link until HTTPS is on. Run as root, a Ctrl-C
            # there reaches this script too, and would end it before Yantra installs.
            trap 'echo' INT
            echo "install: on a tailnet that never had HTTPS, tailscale prints a link to turn it on. Ctrl-C skips HTTPS."
            ip=$(tailscale ip -4 2>/dev/null | head -n 1) || true
            if [ -z "$ip" ] ||
                ! as_root tailscale serve --bg --https="$HTTPS_PORT" "http://$ip:$PORT" </dev/tty; then
                echo "install: tailscale serve failed, so the dashboard is on plain HTTP."
            fi
            trap - INT
        fi
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
    as_root mv -f "$BIN_DIR/$binary.new" "$BIN_DIR/$binary"
done

as_root install -m 644 "$staged/yantrad.service" "$staged/yantra-agent.service" /etc/systemd/system/
as_root systemctl daemon-reload

address=
if [ "$interactive" = yes ] && up; then
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

if [ -n "$address" ]; then
    running=no
    if systemctl is-active --quiet yantrad.service ||
        systemctl is-active --quiet yantra-agent.service; then
        running=yes
    fi
    as_root systemctl enable --now yantrad.service
    if grep -q '^YANTRA_DAEMON=' "$AGENT_ENV"; then
        as_root systemctl enable --now yantra-agent.service
    else
        echo "install: $AGENT_ENV names no daemon, so yantra-agent is not started. Add: YANTRA_DAEMON=$address"
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

    # Applying an update is Y-368's; this run replaced the files and nothing else.
    if [ "$running" = yes ]; then
        echo "install: the units still run the version before v$VERSION. To run it: sudo systemctl restart yantrad.service yantra-agent.service"
    fi

    # Self comes before Peer in the status JSON, so the first DNSName is this box's.
    name=$(tailscale status --json | grep -o '"DNSName": *"[^"]*"' | head -n 1 | cut -d '"' -f 4) || true
    if [ -n "$name" ] && serving; then
        echo "install: open the dashboard at https://${name%.}:$HTTPS_PORT"
    else
        echo "install: open the dashboard at http://$address"
    fi
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

cat <<REPORT

install: yantrad, yantra and yantra-agent are in $BIN_DIR; both units are in
install: /etc/systemd/system and neither is enabled. Tailscale is $tailscale_state.

What is left, none of which this script does for you:

  1. $env_step
  2. $tailscale_step
  3. Start them: \`sudo systemctl enable --now yantrad.service yantra-agent.service\`
  4. Add each machine. In a terminal on it, as the account Yantra is to log in as:
     \`curl -fsSL http://<this box's tailnet address>:7717/join | sh\`. The daemon
     makes its ssh key the first time a machine joins.

Run this script again at a terminal and it does 2, starts yantrad and prints
the dashboard's address. Step 1 stays yours: it never rewrites an agent.env
that exists, and yantra-agent starts once that file names the daemon.
REPORT
