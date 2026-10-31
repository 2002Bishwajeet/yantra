#!/bin/sh
# The first internal disk. A USB stick can report removable=0, so check its bus as well.
for path in /sys/block/nvme* /sys/block/sd* /sys/block/vd*; do
    [ -e "$path" ] || continue
    [ "$(cat "$path/removable")" = 0 ] || continue
    case "$(readlink -f "$path")" in *usb*) continue ;; esac
    disk=/dev/${path##*/}
    debconf-set partman-auto/disk "$disk"
    debconf-set grub-installer/bootdev "$disk"
    exit 0
done
exit 1
