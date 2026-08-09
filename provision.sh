#!/usr/bin/env bash
#
# The provisioning half of the install. Start what this box can start, ask
# `yantra doctor` what the fleet still needs, and print everything left as a
# numbered step with the command that ends it.
#
#     curl -fsSL <url>/provision.sh | bash
#
# Run it after install.sh, which puts the software here and stops. This enrols
# no Tailscale node, writes no daemon address and generates no ssh key: each of
# those is the owner's, and each one is a numbered step below rather than a
# thing this script quietly did not do. docs/appliance.md is the runbook.
set -euo pipefail

BIN=/usr/local/bin/yantra
AGENT_ENV=/etc/yantra/agent.env

fail() {
    echo "provision: $*" >&2
    exit 1
}

if [ "$(id -u)" -eq 0 ]; then
    as_root() { "$@"; }
else
    command -v sudo >/dev/null 2>&1 ||
        fail "this needs root and there is no sudo on this box"
    as_root() { sudo "$@"; }
fi

for tool in systemctl awk runuser; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
done

[ -x "$BIN" ] ||
    fail "$BIN is not here — install.sh installs it, and this script provisions what it installed"
id yantra >/dev/null 2>&1 ||
    fail "there is no yantra account — install.sh creates it"
home=$(getent passwd yantra | cut -d: -f6)

# Both units run as `yantra`, so that account's workspaces and ssh identity are
# what the daemon will drive; asked as anyone else, `doctor` reports a fleet
# nobody runs. `runuser` passes the caller's environment through, and systemd
# gives a system unit no `XDG_RUNTIME_DIR` — dropping it is what puts the control
# sockets where `yantrad`'s own land.
as_yantra() { as_root runuser -u yantra -- env -u XDG_RUNTIME_DIR "HOME=$home" "$@"; }

steps=()
unknowns=()
done_here=()
step() { steps+=("$1"); }

if ! command -v tailscale >/dev/null 2>&1; then
    tailnet=no
    step "Install Tailscale and enrol this box. \`yantrad\` refuses to start until it can name
     this machine's addresses. The auth key is yours and is never read here, and whether
     the node is enrolled tagged is Q17."
elif tailscale status >/dev/null 2>&1; then
    tailnet=yes
else
    tailnet=no
    step "Enrol this box: \`sudo tailscale up\`. \`yantrad\` refuses to start until it can name
     this machine's addresses, and the key that enrols it is never this script's."
fi

# ADR-0013 §4: the address is named rather than written, and the command appends
# so install.sh's placeholder stays readable above the line it adds.
if grep -q '^YANTRA_DAEMON=' "$AGENT_ENV" 2>/dev/null; then
    addressed=yes
else
    addressed=no
    step "Give \`yantra-agent\` the daemon's address — an address, never a MagicDNS name:
     \`printf 'YANTRA_DAEMON=100.x.x.x:7717\\n' | sudo tee -a $AGENT_ENV\`"
fi

start() {
    local unit=$1 ready=$2 blocked=$3
    systemctl is-active --quiet "$unit" && return 0
    if [ "$ready" = no ]; then
        step "$blocked
     Then: \`sudo systemctl enable --now $unit\`"
        return 0
    fi
    # Asked again afterwards: `enable --now` reports that systemd forked the
    # process, not that it survived, and `yantrad` refuses to start for reasons
    # this script cannot see.
    if as_root systemctl enable --now "$unit" && systemctl is-active --quiet "$unit"; then
        done_here+=("enabled and started $unit")
    else
        step "\`$unit\` is enabled and is not running. Read why:
     \`journalctl -u $unit -n 20 --no-pager\`"
    fi
}

start yantrad.service "$tailnet" "Enrol this box in the tailnet, which is the step above this one."
start yantra-agent.service "$addressed" "Set YANTRA_DAEMON, which is a step above this one."

# Asked as root: the account's home is its own, and a `test` that cannot read the
# directory would report every box as having no identity.
if ! as_root test -e "$home/.ssh/config"; then
    step "Give the \`yantra\` account an ssh identity the fleet authorises — a key, a
     \`~/.ssh/config\` and a \`known_hosts\`. Generating one is not this script's (Y-144):
     \`sudo -u yantra ssh-keygen -t ed25519 -f $home/.ssh/id_yantra -N ''\`"
fi

# --json rather than the table, because D2.2 pinned that shape for exactly this
# reader. The exit status is dropped: `heartbeat` is never *present* from a
# caller that is not the daemon, so `doctor` is always non-zero here.
report=$(as_yantra "$BIN" doctor --json) || true
[ -n "$report" ] ||
    fail "\`yantra doctor --json\` printed nothing — \`sudo -u yantra $BIN doctor\` says why"

# The pinned shape puts a machine's name after its checks, so they are held until
# the name arrives. `detail` is cut at the first colon rather than split on
# quotes: it carries ssh's own diagnostics, which may hold either.
checks=$(printf '%s\n' "$report" | awk -F'"' '
    $2 == "check"   { c = $4 }
    $2 == "detail"  { d = substr($0, index($0, ":") + 3); sub(/",?$/, "", d) }
    $2 == "state"   { n++; ck[n] = c; st[n] = $4; dt[n] = d }
    $2 == "machine" { for (i = 1; i <= n; i++) print $4 "\t" ck[i] "\t" st[i] "\t" dt[i]; n = 0 }
')

if [ -z "$checks" ]; then
    step "No workspace names a machine, so \`doctor\` had nothing to ask about the fleet.
     Create one from the dashboard rather than by copying a file, or:
     \`sudo -u yantra $BIN new <name> --machine <machine> --repo <path on it>\`"
fi

beats=no
while IFS=$'\t' read -r machine check state detail; do
    [ -n "$machine" ] || continue
    [ "$state" = present ] && continue

    # An unknown is not an absent (R-23): it sends a reader to the machine, not
    # to an install, so it gets a reason rather than an instruction.
    if [ "$state" = unknown ]; then
        [ "$check" = heartbeat ] && beats=yes && continue
        unknowns+=("$machine  $check — $detail")
        continue
    fi
    evidence="     doctor: $machine $check is $state — $detail"

    case "$check" in
    reachable)
        step "Place the \`yantra\` account's public key in \`$machine\`'s authorized_keys and
     give it a \`~/.ssh/config\` entry, then: \`sudo -u yantra ssh -o BatchMode=yes $machine true\`
$evidence"
        ;;
    sshd)
        step "\`$machine\` answered and nothing is listening on its ssh port. At that machine:
     \`sudo systemctl enable --now sshd\`
$evidence"
        ;;
    tmux)
        step "Install tmux on \`$machine\` with that machine's package manager, which \`doctor\`
     does not report. Then: \`$BIN doctor $machine\`
$evidence"
        ;;
    agent-cli)
        step "Install Claude Code on \`$machine\`:
     \`ssh $machine 'curl -fsSL https://claude.ai/install.sh | bash'\`
$evidence"
        ;;
    terminfo)
        if as_yantra "$BIN" fix-terminfo "$machine" >/dev/null; then
            done_here+=("taught $machine the terminal this box is sitting at")
        else
            step "Teach \`$machine\` this terminal: \`sudo -u yantra $BIN fix-terminfo $machine\`
$evidence"
        fi
        ;;
    provider-cli)
        step "Install \`gh\` on \`$machine\` with that machine's package manager, so repositories
     can be browsed from the dashboard.
$evidence"
        ;;
    provider-auth)
        step "Log in on \`$machine\`: \`ssh -t $machine gh auth login\`. The browser half is yours
     and no credential is read, echoed or stored here.
$evidence"
        ;;
    login-session)
        step "Run \`claude\` on \`$machine\` once, to store a credential where the agent will run.
     On macOS start its tmux server from the login session first (ADR-0018 §1, I-44).
$evidence"
        ;;
    esac
done <<<"$checks"

echo
if [ ${#done_here[@]} -gt 0 ]; then
    printf 'provision: %s\n' "${done_here[@]}"
    echo
fi

if [ ${#steps[@]} -eq 0 ] && [ ${#unknowns[@]} -eq 0 ]; then
    echo "provision: nothing is left — every check \`doctor\` answers from here is present."
    exit 0
fi

if [ ${#steps[@]} -gt 0 ]; then
    echo "What is left, none of which this script does for you:"
    echo
    i=1
    for one in "${steps[@]}"; do
        printf '  %d. %s\n' "$i" "$one"
        i=$((i + 1))
    done
    echo
fi

if [ ${#unknowns[@]} -gt 0 ]; then
    echo "Not asked, so not known — go to the machine rather than install anything:"
    echo
    printf '  - %s\n' "${unknowns[@]}"
    echo
fi

if [ "$beats" = yes ]; then
    echo "provision: \`heartbeat\` is unknown from here for every machine and always will be — the
provision: beats live in the running daemon's memory and the CLI is not one of its
provision: clients. The dashboard's readiness card is what answers it."
fi

exit 1
