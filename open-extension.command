#!/bin/bash
set -e
LOCATION="$HOME/Library/Application Support/TokenDesk/Chrome_Extension"
if [[ ! -d "$LOCATION" ]]; then
  echo '请先运行 安装到Mac.command，安装器会复制浏览器扩展到稳定位置。'
  exit 1
fi
/usr/bin/open "$LOCATION"
if [[ -d "/Applications/Google Chrome.app" ]]; then
  /usr/bin/open -a "Google Chrome" 'chrome://extensions/'
else
  echo '没有找到 Chrome，请手动打开 Chrome 并输入 chrome://extensions/'
fi
printf '在 Chrome 开启开发者模式，点击“加载已解压的扩展程序”，选择 Finder 打开的文件夹。\n'
