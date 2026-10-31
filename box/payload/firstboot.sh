#!/bin/bash
set -euo pipefail
user=$(cat /etc/yantra-box.user)
state=/var/lib/yantra-box

until curl -fsS -o /dev/null https://github.com; do sleep 5; done

# Containers and tmux sessions must outlive a logout.
loginctl enable-linger "$user"

if [ ! -f "$state/user-done" ]; then
    # Not sudo -i: it mangles the newlines of a multi-line command.
    sudo -Hu "$user" bash "$state/setup-user.sh" "$state/home.tar.gz"
    touch "$state/user-done"
fi
# I-34: a non-interactive ssh command does not read ~/.profile, so ~/.local/bin is not on its PATH.
ln -sf "/home/$user/.local/bin/claude" /usr/local/bin/claude

bash "$state/ui/install.sh" "$user" || echo 'yantra-box: FAILED: the login screen'

# Last, because with no auth key this step waits for a person to open the login link.
[ ! -s /etc/yantra-box.tskey ] || export TS_AUTHKEY=$(cat /etc/yantra-box.tskey)
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | bash -s -- --yes
tailscale set --auto-update || echo 'yantra-box: tailscale auto-update is not on'

rm -rf /etc/yantra-box.tskey /etc/yantra-box.user "$state"
systemctl disable yantra-firstboot.service
echo "yantra-box: first boot finished"
