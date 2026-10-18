#!/usr/bin/env bash
# GCE startup script: runs as root on every boot. Idempotent.
set -euo pipefail
exec > >(logger -t muse-proxy-startup) 2>&1

# 2 GB swap: the browser container can spike past the e2-micro's 1 GB RAM.
if ! swapon --show | grep -q /swapfile; then
  [[ -f /swapfile ]] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile; }
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=20 >/dev/null
fi

if ! command -v docker >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl unattended-upgrades
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
  dpkg-reconfigure -f noninteractive unattended-upgrades
fi

# Debian's image ships exim4 on 127.0.0.1:25, which blocks publishing port 25. We don't need a local MTA.
if systemctl list-unit-files exim4.service >/dev/null 2>&1; then
  systemctl disable --now exim4 >/dev/null 2>&1 || true
  systemctl mask exim4 >/dev/null 2>&1 || true
fi

# Keep container logs small on a 30 GB disk.
if [[ ! -f /etc/docker/daemon.json ]]; then
  echo '{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}' > /etc/docker/daemon.json
  systemctl restart docker
fi

install -d -m 0755 /opt/muse-proxy
install -d -m 0700 -o 1000 -g 1000 /opt/muse-proxy/data /opt/muse-proxy/data/app /opt/muse-proxy/data/caddy /opt/muse-proxy/data/caddy-config
