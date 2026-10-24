#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/platypus-image-build.log /dev/ttyS0) 2>&1
trap 'echo PLATYPUS_IMAGE_BUILD_FAILED' ERR
for command in chromium Xorg lightdm openbox sgdisk python3; do command -v "$command"; done
systemctl stop lightdm || true
systemctl daemon-reload
systemctl enable platypus-prepare.service lightdm.service qemu-guest-agent.service
systemctl enable systemd-networkd.service systemd-resolved.service
systemctl disable ssh.service ssh.socket || true
systemctl mask ssh.service ssh.socket
mkdir -p /home/workspace/.config/openbox
printf '/usr/local/bin/platypus-browser-session &\n' > /home/workspace/.config/openbox/autostart
chown -R workspace:workspace /home/workspace/.config
ln -sf /etc/machine-id /var/lib/dbus/machine-id
update-initramfs -u -k all
update-grub
apt-get clean
rm -f /etc/ssh/ssh_host_*
touch /etc/cloud/cloud-init.disabled
truncate -s 0 /etc/machine-id
systemctl stop systemd-random-seed.service || true
rm -f /var/lib/systemd/random-seed
fstrim -av || true
sync
echo PLATYPUS_IMAGE_BUILD_COMPLETE
systemctl poweroff
