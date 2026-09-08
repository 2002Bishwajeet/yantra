#!/usr/bin/env bash
#
# Install or update Yantra on an always-on Linux box from a published release.
#
#     curl -fsSL <url>/install.sh | bash
#
# It fetches, verifies and installs. It enrols no Tailscale node, writes no
# daemon address and enables nothing — those are the owner's, and the script
# ends by naming each one. docs/appliance.md is the runbook around it.
set -euo pipefail

REPO=2002Bishwajeet/yantra
BIN_DIR=/usr/local/bin
AGENT_ENV=/etc/yantra/agent.env
DAEMON_ENV=/etc/yantra/daemon.env

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

# ADR-0013 §4: the address of the daemon *this* box reports to is not this
# script's to know, and never its to rewrite.
if [ -e "$AGENT_ENV" ]; then
    env_step="$AGENT_ENV was already here and was left alone."
else
    as_root install -d /etc/yantra
    as_root tee "$AGENT_ENV" >/dev/null <<'ENV'
# The address of the machine running yantrad, and the agent's whole
# configuration (ADR-0013 §4). An address, never a MagicDNS name.
#YANTRA_DAEMON=100.x.x.x:7717
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
ENV
    as_root chown yantra:yantra "$DAEMON_ENV"
    as_root chmod 600 "$DAEMON_ENV"
fi

# Reported, never enrolled: the auth key is the owner's, and whether this node is
# tagged is Q17 — an answer that may make the daemon refuse every write.
if ! command -v tailscale >/dev/null 2>&1; then
    tailscale_state="not installed"
    tailscale_step="Install Tailscale and enrol this box. yantrad refuses to start until it can name this machine's addresses."
elif tailscale status >/dev/null 2>&1; then
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
  4. Give this box an ssh identity the fleet authorises, and place the public key
     it prints: \`sudo -u yantra -H $BIN_DIR/yantra ssh-identity\`. Until it has
     one the daemon starts and every verb that reaches another machine fails.

provision.sh, from wherever you fetched this, does step 3 once 1 and 2 hold and
prints whatever is still left, this box's and the fleet's.
REPORT
