#!/bin/sh
set -e
user=$(cat /yantra/user)
home=/target/home/$user

mkdir -p "$home/.ssh"
cp /yantra/authorized_keys "$home/.ssh/authorized_keys"
chmod 700 "$home/.ssh"
chmod 600 "$home/.ssh/authorized_keys"
in-target chown -R "$user:$user" "/home/$user/.ssh"

printf 'PasswordAuthentication no\n' >/target/etc/ssh/sshd_config.d/10-yantra-box.conf

cp /yantra/firstboot.sh /target/usr/local/sbin/yantra-firstboot
chmod 700 /target/usr/local/sbin/yantra-firstboot
cp /yantra/yantra-firstboot.service /target/etc/systemd/system/
cp /yantra/user /target/etc/yantra-box.user
mkdir -p /target/var/lib/yantra-box
cp -r /yantra/setup-user.sh /yantra/home.tar.gz /yantra/ui /target/var/lib/yantra-box/
[ ! -s /yantra/ts-authkey ] || install -m 600 /yantra/ts-authkey /target/etc/yantra-box.tskey
in-target systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
in-target chsh -s /usr/bin/zsh "$user"
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/target/etc/apt/apt.conf.d/20auto-upgrades
in-target systemctl enable yantra-firstboot.service
