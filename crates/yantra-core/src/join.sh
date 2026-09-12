#!/bin/sh
#
# Join this machine to a Yantra fleet (Y-387, docs/adr/0029-a-machine-joins-itself.md).
#
#     curl -fsSL https://<appliance>/join | sh
#
# Run it in a terminal on this machine, as the account Yantra is to log in as.
# It asks before each step that needs root, and your own sudo answers.
#
# YANTRA_JOIN_ANSWER=y (or n) answers every question at once, for a test or a
# run with no terminal. With neither, it takes no step that needs root.
set -eu

# yantrad writes these three when it serves this script.
DAEMON='__YANTRA_DAEMON__'
KEY='__YANTRA_KEY__'
VERSION='__YANTRA_VERSION__'
REPO=2002Bishwajeet/yantra

say() { printf 'join: %s\n' "$*"; }

fail() {
    printf 'join: %s\n' "$*" >&2
    exit 1
}

# `curl | sh` makes stdin this script, so an answer comes from the terminal.
ask() {
    if [ -n "${YANTRA_JOIN_ANSWER:-}" ]; then
        answer=$YANTRA_JOIN_ANSWER
    elif (: </dev/tty) 2>/dev/null; then
        printf 'join: %s [Y/n] ' "$1" >/dev/tty
        read -r answer </dev/tty || answer=n
        [ -n "$answer" ] || answer=y
    else
        answer=n
    fi
    case "$answer" in
    y | Y | yes | Yes | YES) return 0 ;;
    *) return 1 ;;
    esac
}

as_root() {
    command -v sudo >/dev/null 2>&1 || fail "this step needs root and there is no sudo here: $*"
    sudo "$@"
}

fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$1" "$2"; }

[ "$(id -u)" -ne 0 ] ||
    fail "run this as the account Yantra is to log in as, not as root. It asks for sudo itself."
command -v curl >/dev/null 2>&1 || fail "curl is not installed"

user=$(id -un)
case "$user" in
'' | -* | .* | *[!A-Za-z0-9._-]*)
    fail "the account name '$user' cannot go into an ssh config, so Yantra cannot log in as it"
    ;;
esac
[ "${#user}" -le 32 ] || fail "the account name '$user' is longer than 32 characters"

os=$(uname -s)
case "$os" in
Linux | Darwin) ;;
*) fail "$os is not a machine Yantra runs sessions on yet" ;;
esac

pm=
for candidate in apt-get dnf pacman zypper apk brew; do
    if command -v "$candidate" >/dev/null 2>&1; then
        pm=$candidate
        break
    fi
done

install_packages() {
    case "$pm" in
    apt-get) as_root apt-get update -q && as_root apt-get install -y "$@" ;;
    dnf) as_root dnf install -y "$@" ;;
    pacman) as_root pacman -S --needed --noconfirm "$@" ;;
    zypper) as_root zypper --non-interactive install "$@" ;;
    apk) as_root apk add "$@" ;;
    brew) brew install "$@" ;;
    *) return 1 ;;
    esac
}

# Port 22 is 0016 in hex, and 0A is LISTEN. macOS has no /proc.
sshd_listening() {
    if [ -r /proc/net/tcp ]; then
        cat /proc/net/tcp /proc/net/tcp6 2>/dev/null |
            awk '$2 ~ /:0016$/ && $4 == "0A" { found = 1 } END { exit !found }'
    else
        nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1
    fi
}

wait_for_sshd() {
    for _ in 1 2 3 4 5; do
        sshd_listening && return 0
        sleep 1
    done
    return 1
}

linux_sshd() {
    if ! [ -x /usr/sbin/sshd ] && ! command -v sshd >/dev/null 2>&1; then
        if [ -z "$pm" ]; then
            say "sshd is not installed, and there is no package manager here that this script knows."
            return 1
        fi
        package=openssh-server
        [ "$pm" != pacman ] || package=openssh
        ask "sshd is not installed. Install $package with $pm?" || return 1
        install_packages "$package" || return 1
        wait_for_sshd && return 0
    fi
    if ! command -v systemctl >/dev/null 2>&1; then
        say "start sshd with this machine's own init system."
        return 1
    fi
    ask "sshd is not running. Turn it on now and at every boot?" || return 1
    # Debian names the unit ssh, and Fedora and Arch name it sshd.
    for unit in ssh.service sshd.service; do
        if systemctl cat "$unit" >/dev/null 2>&1; then
            as_root systemctl enable --now "$unit" || return 1
            wait_for_sshd
            return
        fi
    done
    say "found no ssh or sshd unit to start."
    return 1
}

# Only System Settings turns Remote Login on: `systemsetup -setremotelogin`
# needs Full Disk Access (man systemsetup; Apple HT210595).
mac_remote_login() {
    say "Remote Login is off, and a script cannot turn it on."
    say "Open System Settings > General > Sharing, turn on Remote Login, and allow access for $user."
    tries=0
    while [ "$tries" -lt 3 ] && ask "Is Remote Login on now?"; do
        tries=$((tries + 1))
        wait_for_sshd && return 0
        say "port 22 still does not answer."
    done
    fail "Remote Login is off, so nothing was changed. Run this again once it is on."
}

place_key() {
    umask 077
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    keys=$HOME/.ssh/authorized_keys
    if [ -f "$keys" ] && grep -qxF "$KEY" "$keys"; then
        say "the appliance's key was already in $keys."
        return 0
    fi
    # A file that ends mid-line would join the key onto its last entry.
    if [ -s "$keys" ] && [ -n "$(tail -c 1 "$keys")" ]; then
        printf '\n' >>"$keys"
    fi
    printf '%s\n' "$KEY" >>"$keys"
    chmod 600 "$keys"
    if command -v restorecon >/dev/null 2>&1; then
        restorecon -R "$HOME/.ssh" 2>/dev/null || true
    fi
    say "the appliance's key is in $keys."
}

basics() {
    missing=
    for tool in tmux git; do
        command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
    done
    missing=${missing# }
    if [ -z "$missing" ]; then
        say "tmux and git are here."
    elif [ -z "$pm" ]; then
        say "$missing is missing, and there is no package manager here that this script knows."
    elif ask "Install $missing with $pm?"; then
        # One word per package, so the list is split on purpose.
        # shellcheck disable=SC2086
        install_packages $missing || say "$missing did not install. The dashboard's Install can try again."
    else
        say "left $missing out. The dashboard's Install can add it later."
    fi
}

# The archive is checked against SHA256SUMS the way install.sh checks it, and a
# mismatch stops everything: that is a corrupt or a substituted download.
fetch_agent() {
    target=$1
    archive="yantra-$VERSION-$target.tar.gz"
    work=$(mktemp -d)
    download="https://github.com/$REPO/releases/download/v$VERSION"
    if ! fetch "$work/$archive" "$download/$archive" || ! fetch "$work/SHA256SUMS" "$download/SHA256SUMS"; then
        rm -rf "$work"
        say "could not download yantra-agent v$VERSION, so it was not installed."
        return 1
    fi
    if [ "$os" = Linux ]; then
        verified=$(cd "$work" && sha256sum -c --ignore-missing SHA256SUMS >/dev/null 2>&1 && echo yes || true)
    else
        verified=$(cd "$work" && grep " $archive\$" SHA256SUMS >one && shasum -a 256 -c one >/dev/null 2>&1 && echo yes || true)
    fi
    if [ "$verified" != yes ]; then
        rm -rf "$work"
        fail "$archive does not match SHA256SUMS, so yantra-agent was not installed and nothing was reported"
    fi
    tar -C "$work" -xzf "$work/$archive"
    staged="$work/yantra-$VERSION-$target"
}

linux_agent() {
    if [ -e /usr/local/bin/yantra-agent ]; then
        say "yantra-agent is already installed, and was left alone."
        return 0
    fi
    if ! command -v systemctl >/dev/null 2>&1; then
        say "there is no systemd here, so yantra-agent was not installed."
        return 0
    fi
    case "$(uname -m)" in
    aarch64 | arm64) target=aarch64-unknown-linux-musl ;;
    x86_64 | amd64) target=x86_64-unknown-linux-musl ;;
    *)
        say "no yantra-agent is built for $(uname -m)."
        return 0
        ;;
    esac
    ask "Install yantra-agent, the heartbeat that tells the dashboard this machine is awake?" || return 0
    fetch_agent "$target" || return 0

    # The unit runs as this account, as it does on the appliance.
    id yantra >/dev/null 2>&1 ||
        as_root useradd --system --no-create-home --shell /usr/sbin/nologin yantra
    as_root install -d /usr/local/bin
    as_root install -m 755 "$staged/yantra-agent" /usr/local/bin/yantra-agent.new
    as_root mv -f /usr/local/bin/yantra-agent.new /usr/local/bin/yantra-agent
    as_root install -m 644 "$staged/yantra-agent.service" /etc/systemd/system/
    # ADR-0013 §4: the address is written once and never rewritten.
    if [ -e /etc/yantra/agent.env ]; then
        say "/etc/yantra/agent.env was already here, and was left alone."
    else
        as_root install -d /etc/yantra
        printf '# The address of the machine running yantrad (ADR-0013 §4).\nYANTRA_DAEMON=%s\n' "$DAEMON" |
            as_root tee /etc/yantra/agent.env >/dev/null
        as_root chmod 644 /etc/yantra/agent.env
    fi
    as_root systemctl daemon-reload
    as_root systemctl enable --now yantra-agent.service
    rm -rf "$work"
    say "yantra-agent is running, and reports to $DAEMON."
}

# A LaunchAgent in this person's own login session (ADR-0018 §7's domain), so
# it needs no root. Not measured on a Mac yet.
mac_agent() {
    label=io.github.2002bishwajeet.yantra-agent
    plist=$HOME/Library/LaunchAgents/$label.plist
    if [ -e "$plist" ]; then
        say "$plist was already here, and was left alone."
        return 0
    fi
    case "$(uname -m)" in
    arm64) target=aarch64-apple-darwin ;;
    *) target=x86_64-apple-darwin ;;
    esac
    ask "Install yantra-agent, the heartbeat that tells the dashboard this machine is awake?" || return 0
    fetch_agent "$target" || return 0

    bin=$HOME/.local/bin/yantra-agent
    mkdir -p "$HOME/.local/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    install -m 755 "$staged/yantra-agent" "$bin"
    cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key><array><string>$bin</string></array>
    <key>EnvironmentVariables</key><dict><key>YANTRA_DAEMON</key><string>$DAEMON</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardErrorPath</key><string>$HOME/Library/Logs/yantra-agent.log</string>
</dict>
</plist>
PLIST
    launchctl bootstrap "gui/$(id -u)" "$plist"
    rm -rf "$work"
    say "yantra-agent is running, and reports to $DAEMON."
}

# The daemon names this machine from the address the request comes from, so
# the body carries the account and nothing else (ADR-0016, ADR-0029).
report() {
    reply=$(curl -sS --max-time 30 -w '\n%{http_code}' -H 'Content-Type: application/json' \
        -d "{\"user\":\"$user\"}" "http://$DAEMON/api/join") ||
        fail "could not reach yantrad at $DAEMON, so it does not know this machine joined. Run this again."
    status=$(printf '%s\n' "$reply" | tail -n 1)
    body=$(printf '%s\n' "$reply" | sed '$d')
    [ "$status" = 200 ] || fail "yantrad answered $status: $body"
    case "$body" in
    *'"configured":false'*)
        say "yantrad's ssh config already named this machine, so it kept what was there."
        ;;
    *) say "yantrad now logs in here as $user." ;;
    esac
}

say "this lets the Yantra appliance at $DAEMON log in here as $user."

if sshd_listening; then
    say "sshd is running."
elif [ "$os" = Darwin ]; then
    mac_remote_login
elif ! linux_sshd; then
    say "sshd is not running, so Yantra cannot reach this machine yet. The rest goes on anyway."
fi

place_key
basics
if [ "$os" = Darwin ]; then
    mac_agent
else
    linux_agent
fi
report
say "done. Open the dashboard: this machine's Check turns green once Yantra reaches it."
