#!/bin/bash
set -euo pipefail
APP="$HOME/Applications/TokenDesk.app"
if [[ ! -d "$APP" ]]; then
  echo '没有找到 ~/Applications/TokenDesk.app，请先运行安装器。'
  exit 1
fi
/usr/bin/pkill -x TokenDesk >/dev/null 2>&1 || true
/usr/bin/xattr -cr "$APP" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"
LOG="$HOME/Library/Logs/TokenDesk_launch.log"
mkdir -p "$(dirname "$LOG")"
/usr/bin/nohup "$APP/Contents/MacOS/TokenDesk" >"$LOG" 2>&1 &
sleep 1
if /usr/bin/pgrep -x TokenDesk >/dev/null 2>&1; then
  echo '✅ TokenDesk 已启动。'
else
  echo '❌ 进程没有启动。最近日志：'
  tail -n 30 "$LOG" 2>/dev/null || true
fi
