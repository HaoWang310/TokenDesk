#!/bin/bash
# TokenDesk Chrome extension-only patch 1.7.1
set -Eeuo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "只适用于 macOS。"; exit 1
fi
SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/Chrome_Extension"
DST="$HOME/Library/Application Support/TokenDesk/Chrome_Extension"
if [[ ! -f "$SRC/manifest.json" || ! -f "$SRC/extract.js" || ! -f "$SRC/network-hook.js" || ! -f "$SRC/task-monitor.js" ]]; then
  echo "找不到扩展源码，请解压完整 ZIP 后重试。"; exit 2
fi
PARENT="$(dirname "$DST")"
STAGE="$PARENT/Chrome_Extension.new.$$"
mkdir -p "$PARENT"
rm -rf -- "$STAGE"
mkdir -p "$STAGE"
cp -R "$SRC/." "$STAGE/"
# Clean replacement: remove obsolete files from older extension versions.
rm -rf -- "$DST"
mv "$STAGE" "$DST"
echo ''
echo '✅ 网页扩展 v1.7.1 文件已更新。注意：运行任务面板属于 Mac 主程序功能；若要使用新面板，请运行“安装到Mac.command”。'
echo '【必须操作】Chrome 打开 chrome://extensions，找到 TokenDesk 网页额度同步，点「重新加载」。'
echo 'Chrome 保持运行并登录 ChatGPT 即可；无需打开 ChatGPT 或“设置 → 用量”页面。'
echo '扩展会约每 30 秒后台主动查询额度，并同步运行中的 ChatGPT 网页任务到 TokenDesk。'
echo ''
echo "扩展安装路径：$DST"
