#!/bin/bash
# Gives a box Yantra's name, colours and login screen. Safe to run twice.
# Usage: sudo bash install.sh <login-user>. On a built box, first boot runs it.
set -euo pipefail
cd "$(dirname "$0")"
owner=${1:-${SUDO_USER:?name the login user}}
share=/usr/local/share/yantra-box
zellij_v=0.45.1 systemctl_tui_v=0.8.0 wtf_v=0.51.0
esc=$'\033'

apt-get install -y -qq gum jq curl btop >/dev/null

t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
base=https://github.com
curl -fsSL "$base/zellij-org/zellij/releases/download/v$zellij_v/zellij-x86_64-unknown-linux-musl.tar.gz" | tar xz -C "$t"
curl -fsSL "$base/rgwood/systemctl-tui/releases/download/v$systemctl_tui_v/systemctl-tui-x86_64-unknown-linux-musl.tar.gz" | tar xz -C "$t"
curl -fsSL "$base/wtfutil/wtf/releases/download/v$wtf_v/wtf_${wtf_v}_linux_amd64.tar.gz" | tar xz -C "$t"
# A copy in ~/.local/bin would shadow these.
rm -f "$(getent passwd "$owner" | cut -d: -f6)"/.local/bin/yantra-{card,home,menu}
install -m 755 "$(find "$t" -type f -name zellij)" "$(find "$t" -type f -name systemctl-tui)" \
    "$(find "$t" -type f -name wtfutil)" bin/yantra-card bin/yantra-home bin/yantra-menu /usr/local/bin/

mkdir -p "$share"
cp -r zellij wtf mark.ansi "$share/"

# Hold Esc at boot for the GRUB menu; timeout 0 would leave no way in.
# The vt lists are the 16 console colours; 0, 3, 7, 11 and 15 carry the brand.
mkdir -p /etc/default/grub.d
cat >/etc/default/grub.d/yantra.cfg <<'CFG'
GRUB_TIMEOUT=1
GRUB_TIMEOUT_STYLE=hidden
GRUB_CMDLINE_LINUX_DEFAULT="quiet loglevel=0 vt.default_red=29,170,0,217,0,170,0,246,85,255,85,255,85,255,85,246 vt.default_grn=28,0,170,115,0,0,170,240,85,85,255,181,85,85,255,240 vt.default_blu=19,0,0,74,170,170,170,226,85,85,85,155,255,255,255,226"
CFG
update-grub 2>/dev/null

printf '\n  %s[93mY A N T R A%s[0m  %s[33m\\n%s[0m\n\n' "$esc" "$esc" "$esc" "$esc" >/etc/issue
# ID stays debian, so apt and upgrades keep working.
sed -i 's/^PRETTY_NAME=.*/PRETTY_NAME="Yantra"/' /usr/lib/os-release

: >/etc/motd
rm -f /etc/update-motd.d/10-uname
cat >/etc/ssh/sshd_config.d/20-yantra-ui.conf <<'CFG'
DebianBanner no
PrintLastLog no
CFG
sshd -t
systemctl reload ssh || true

# Login shells only, so `ssh box command`, scp and Yantra's own ssh never see the screen.
line='[[ -o interactive && -t 0 && -z $TMUX && -z $ZELLIJ ]] && yantra-home'
file=$(getent passwd "$owner" | cut -d: -f6)/.zprofile
sed -i '/yantra-menu$/d;/yantra-home$/d' "$file" 2>/dev/null || true
printf '%s\n' "$line" >>"$file"
chown "$owner:" "$file"

echo 'yantra-ui: done. Open a new SSH login to see it. The console colours need a reboot.'
