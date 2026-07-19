#!/usr/bin/env bash
# Flock Fortress service manager.
# Usage: ./manage.sh {start|stop|restart|status|enable|disable|logs|health|help}
# Run as user hs. start/stop/restart/enable/disable invoke sudo because the service is system-wide.
# enable/disable only change boot-time activation and never start or stop the current process.
set -eu

SERVICE="flock-fortress.service"
HEALTH_URL="${FLOCK_HEALTH_URL:-http://127.0.0.1/healthz}"

help_text() {
  printf '%s\n' \
    "Flock Fortress 管理脚本" \
    "" \
    "用法: ./manage.sh <命令>" \
    "" \
    "  start    启动服务（需要 sudo）" \
    "  stop     停止服务（需要 sudo）" \
    "  restart  重启服务（需要 sudo）" \
    "  status   查看进程与资源状态" \
    "  enable   仅启用开机自启动，不启动当前服务（需要 sudo）" \
    "  disable  仅禁用开机自启动，不停止当前服务（需要 sudo）" \
    "  logs     查看最近日志并持续跟踪（Ctrl+C 退出）" \
    "  health   调用本机健康检查接口" \
    "  help     显示本帮助"
}

case "${1:-help}" in
  start) sudo systemctl start "$SERVICE" ;;
  stop) sudo systemctl stop "$SERVICE" ;;
  restart) sudo systemctl restart "$SERVICE" ;;
  status) systemctl --no-pager --full status "$SERVICE"; printf '\n'; systemctl show "$SERVICE" -p MainPID -p MemoryCurrent -p MemoryPeak -p TasksCurrent ;;
  enable) sudo systemctl enable "$SERVICE" ;;
  disable) sudo systemctl disable "$SERVICE" ;;
  logs) journalctl -u "$SERVICE" -n 120 -f ;;
  health) curl --fail --silent --show-error --max-time 4 "$HEALTH_URL"; printf '\n' ;;
  help|-h|--help) help_text ;;
  *) printf '未知命令: %s\n\n' "$1" >&2; help_text >&2; exit 2 ;;
esac
