#!/usr/bin/env bash
# Installs/updates only the systemd unit. Run as root after project files are owned by hs.
set -eu
if [ "$(id -u)" -ne 0 ]; then
  printf '请使用 root 运行：sudo ./deploy/install-service.sh\n' >&2
  exit 1
fi
project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
unit_source="$project_dir/deploy/flock-fortress.service"
unit_target="/etc/systemd/system/flock-fortress.service"
if [ -f "$unit_target" ]; then
  cp -a "$unit_target" "${unit_target}.backup.$(date +%Y%m%d%H%M%S)"
fi
install -m 0644 "$unit_source" "$unit_target"
systemctl daemon-reload
printf '%s\n' 'systemd 单元已安装。请运行 ./manage.sh start 和 ./manage.sh enable。'
