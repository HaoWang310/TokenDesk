#!/bin/bash
# Compatibility launcher for the Chinese-named installer.
# Always run the canonical, version-current install.command.
set -Eeuo pipefail
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$DIR/install.command" ]]; then
  printf '缺少最新版 install.command。请重新解压完整 TokenDesk Mac 安装包。\n' >&2
  exit 2
fi
exec /bin/bash "$DIR/install.command" "$@"
