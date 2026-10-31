#!/bin/bash
# Usage: ./flash.sh /dev/sdX. Refuses anything that is not a whole USB disk.
set -euo pipefail
cd "$(dirname "$0")"

dev=${1:?usage: ./flash.sh /dev/sdX}
[ "$(lsblk -dno TYPE "$dev")" = disk ] || { echo "$dev is not a whole disk." >&2; exit 1; }
[ "$(lsblk -dno TRAN "$dev")" = usb ] || { echo "$dev is not a USB disk." >&2; exit 1; }

lsblk -o NAME,SIZE,MODEL,LABEL,MOUNTPOINT "$dev"
read -rp "Erase $dev? Type yes: " answer
[ "$answer" = yes ] || exit 1

lsblk -lnpo NAME,MOUNTPOINT "$dev" | awk 'NF==2 {print $1}' | xargs -r sudo umount
sudo dd if=out/yantra-box.iso of="$dev" bs=4M status=progress conv=fsync
sync
echo 'The stick is ready.'
