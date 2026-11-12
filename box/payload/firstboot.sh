#!/bin/bash
set -euo pipefail
user=$(cat /etc/yantra-box.user)
state=/var/lib/yantra-box
agent=karigar

until curl -fsS -o /dev/null https://github.com; do sleep 5; done

# Agents run as an account with no sudo (Y-786).
# `*` is no password and no lock, so sshd still takes the key (Y-628).
id "$agent" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --password '*' "$agent"

# Containers and tmux sessions must outlive a logout.
loginctl enable-linger "$user" "$agent"

if [ ! -f "$state/user-done" ]; then
    # Not sudo -i: it mangles the newlines of a multi-line command.
    sudo -Hu "$user" bash "$state/setup-user.sh" "$state/home.tar.gz"
    touch "$state/user-done"
fi
if [ ! -f "$state/agent-done" ]; then
    sudo -Hu "$agent" bash -o pipefail -c 'curl -fsSL https://claude.ai/install.sh | bash'
    touch "$state/agent-done"
fi
# I-34: a non-interactive ssh command does not read ~/.profile, so ~/.local/bin is not on its PATH.
ln -sf "/home/$agent/.local/bin/claude" /usr/local/bin/claude

bash "$state/ui/install.sh" "$user" || echo 'yantra-box: FAILED: the login screen'

# Last, because with no auth key this step waits for a person to open the login link.
[ ! -s /etc/yantra-box.tskey ] || export TS_AUTHKEY=$(cat /etc/yantra-box.tskey)
# This script is root, so install.sh cannot tell which account yantrad logs in to.
export YANTRA_ACCOUNT=$agent
# Y-787: the tag of the current release, never a branch. own_box.rs serves Cargo.toml's version only.
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/v0.13.0/install.sh | bash -s -- --yes
tailscale set --auto-update || echo 'yantra-box: tailscale auto-update is not on'

rm -rf /etc/yantra-box.tskey /etc/yantra-box.user "$state"
systemctl disable yantra-firstboot.service
echo "yantra-box: first boot finished"
