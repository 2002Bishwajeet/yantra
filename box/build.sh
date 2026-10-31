#!/bin/bash
# Builds out/yantra-box.iso: Debian 13 that installs itself, then Yantra and Claude Code.
# Usage: ./build.sh <ssh-public-key> [dotfiles-dir]. See README.md for the settings.
set -euo pipefail
cd "$(dirname "$0")"

pubkey=${1:?usage: ./build.sh <ssh-public-key> [dotfiles-dir]}
dotfiles=${2:-}
user=${BOX_USER:-yantra-owner}
hostname=${BOX_HOSTNAME:-yantra-box}
tz=${BOX_TZ:-UTC}
mirror=https://cdimage.debian.org/debian-cd/current/amd64/iso-cd

if [ -z "${BOX_PASSWORD:-}" ]; then
    read -rsp 'Password for the box account: ' BOX_PASSWORD; echo
    read -rsp 'Again: ' again; echo
    [ "$BOX_PASSWORD" = "$again" ] || { echo 'The passwords differ.' >&2; exit 1; }
fi
if [ -z "${TS_AUTHKEY+set}" ]; then
    read -rsp 'Tailscale auth key, with no tag (Enter to skip): ' TS_AUTHKEY; echo
fi

mkdir -p cache out work
chmod 700 out work
sums=$(curl -fsSL "$mirror/SHA256SUMS")
line=$(grep -E ' debian-[0-9.]+-amd64-netinst\.iso$' <<<"$sums")
iso=${line##* }
[ -f "cache/$iso" ] || curl -fL -o "cache/$iso" "$mirror/$iso"
(cd cache && sha256sum -c <<<"$line")

rm -rf work/*
cp -r payload work/yantra
cp "$pubkey" work/yantra/authorized_keys
printf '%s\n' "$user" >work/yantra/user
printf '%s' "$TS_AUTHKEY" >work/yantra/ts-authkey

# The dotfiles land in the login user's home. A file .yantra-box/setup.sh there runs at first boot.
mkdir -p work/home
[ -z "$dotfiles" ] || cp -r "$dotfiles/." work/home/
tar -C work/home -czf work/yantra/home.tar.gz .
cp -r ui work/yantra/ui

hash=$(openssl passwd -6 -stdin <<<"$BOX_PASSWORD")
sed -e "s|@@USER@@|$user|g" -e "s|@@HASH@@|$hash|" -e "s|@@HOST@@|$hostname|g" -e "s|@@TZ@@|$tz|" preseed.cfg >work/preseed.cfg

# timeout=-1 waits for Enter, so a stick left in the box can never wipe it after a power cut.
cat >work/grub.cfg <<'CFG'
set default=0
set timeout=-1
menuentry "Install Yantra box - ERASES the internal disk" {
    linux /install.amd/vmlinuz auto=true priority=critical --- quiet
    initrd /install.amd/initrd.gz
}
menuentry "Cancel and power off" {
    halt
}
CFG
cat >work/isolinux.cfg <<'CFG'
default install
prompt 1
timeout 0
say Press Enter to install the Yantra box. This ERASES the internal disk.
label install
    kernel /install.amd/vmlinuz
    append initrd=/install.amd/initrd.gz auto=true priority=critical --- quiet
CFG

podman run --rm --security-opt label=disable -v "$PWD:/box" -w /box/work docker.io/library/debian:13 bash -euc "
apt-get update -qq && apt-get install -y -qq xorriso cpio >/dev/null
xorriso -osirrox on -indev ../cache/$iso -extract /install.amd/initrd.gz initrd.gz
chmod u+w initrd.gz
# A gzip stream appended to an initrd is a second archive, and it overlays the first.
find preseed.cfg yantra | cpio -o -H newc -R 0:0 | gzip >>initrd.gz
rm -f ../out/yantra-box.iso
xorriso -indev ../cache/$iso -outdev ../out/yantra-box.iso -boot_image any replay \
    -map initrd.gz /install.amd/initrd.gz \
    -map grub.cfg /boot/grub/grub.cfg \
    -map isolinux.cfg /isolinux/isolinux.cfg
"
rm -rf work
chmod 600 out/yantra-box.iso
ls -lh out/yantra-box.iso
