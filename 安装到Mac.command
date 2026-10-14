#!/bin/bash
# Token Desk 1.7.7 -- native macOS installer
# Builds locally, installs into ~/Applications, clears quarantine/provenance,
# ad-hoc signs in the final location, then launches the executable directly.
set -Eeuo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo '此安装器只适用于 Mac（macOS）。'
  exit 1
fi

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/Desktop"
[[ -d "$LOG_DIR" && -w "$LOG_DIR" ]] || LOG_DIR="$HOME"
LOG="$LOG_DIR/TokenDesk_安装日志.txt"
: > "$LOG"
exec > >(tee "$LOG") 2>&1

TARGET_DIR="$HOME/Applications"
TARGET_APP="$TARGET_DIR/TokenDesk.app"
STAGE_APP="$TARGET_DIR/.TokenDesk.installing.$$.app"
BACKUP=""

cleanup() {
  status=$?
  rm -rf -- "$STAGE_APP" 2>/dev/null || true
  if [[ "$status" -ne 0 ]]; then
    printf '\n❌ 安装失败（错误代码 %s）。\n' "$status"
    printf '日志：%s\n' "$LOG"
  fi
}
trap cleanup EXIT

printf '\n╔═══════════════════════════════════════════════╗\n'
printf '║          TOKEN DESK · macOS 安装器 v1.7.7      ║\n'
printf '╚═══════════════════════════════════════════════╝\n\n'
SYSTEM_VERSION="$(sw_vers -productVersion)"
MACHINE_ARCH="$(uname -m)"
case "$MACHINE_ARCH" in
  x86_64|arm64) TARGET_ARCH="$MACHINE_ARCH" ;;
  *)
    echo "暂不支持此 Mac 架构：$MACHINE_ARCH（仅支持 Intel x86_64 / Apple Silicon arm64）。"
    exit 8
    ;;
esac
DEPLOYMENT_TARGET="12.0"
if [[ "$MACHINE_ARCH" == "x86_64" ]] && [[ "$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then
  echo '⚠️ 检测到 Apple Silicon 上的 Rosetta 终端：本次会构建 x86_64 版本，仍可运行；若要 arm64 原生版本，请关闭 Terminal 的“使用 Rosetta 打开”后重新安装。'
fi
printf '系统：%s  架构：%s  编译目标：%s-apple-macosx%s\n' "$SYSTEM_VERSION" "$MACHINE_ARCH" "$TARGET_ARCH" "$DEPLOYMENT_TARGET"
printf '安装源目录：%s\n' "$SOURCE_DIR"
printf '安装日志：%s\n\n' "$LOG"

SYSTEM_MAJOR="${SYSTEM_VERSION%%.*}"
if [[ "$SYSTEM_MAJOR" =~ ^[0-9]+$ ]] && (( SYSTEM_MAJOR < 12 )); then
  echo '此版本最低需要 macOS 12 Monterey。'
  exit 6
fi

for f in QuotaModels.swift TokenDeskApp.swift BrowserBridge.swift BrowserUsage.swift Info.plist; do
  if [[ ! -f "$SOURCE_DIR/$f" ]]; then
    echo "缺少文件：$f。请重新解压完整 ZIP。"
    exit 2
  fi
done

if ! /usr/bin/xcrun --find swiftc >/dev/null 2>&1; then
  echo '未找到 Apple Swift 编译工具。将打开 Command Line Tools 安装窗口。'
  /usr/bin/xcode-select --install || true
  exit 3
fi
SWIFTC="$(/usr/bin/xcrun --find swiftc)"
SWIFT_LINE="$($SWIFTC --version 2>/dev/null | /usr/bin/head -n 1 || true)"
SWIFT_VERSION="$(printf '%s\n' "$SWIFT_LINE" | /usr/bin/sed -nE 's/.*Swift version ([0-9]+)\.([0-9]+).*/\1.\2/p')"
if [[ -n "$SWIFT_VERSION" ]]; then
  SWIFT_MAJOR="${SWIFT_VERSION%%.*}"
  SWIFT_MINOR="${SWIFT_VERSION#*.}"
  if (( SWIFT_MAJOR < 5 || (SWIFT_MAJOR == 5 && SWIFT_MINOR < 5) )); then
    echo "Swift 编译器过旧：$SWIFT_LINE"
    echo 'TokenDesk v1.7.7 需要 Swift 5.5 或更新版本，请更新 Xcode Command Line Tools。'
    exit 9
  fi
fi
printf 'Swift：%s\n\n' "${SWIFT_LINE:-未知版本}"

mkdir -p "$TARGET_DIR"
rm -rf -- "$STAGE_APP"
mkdir -p "$STAGE_APP/Contents/MacOS" "$STAGE_APP/Contents/Resources"

printf '[1/5] 创建本机 App…\n'
/usr/bin/ditto --noqtn "$SOURCE_DIR/Info.plist" "$STAGE_APP/Contents/Info.plist" 2>/dev/null || cp "$SOURCE_DIR/Info.plist" "$STAGE_APP/Contents/Info.plist"
/usr/bin/plutil -lint "$STAGE_APP/Contents/Info.plist"

printf '[2/5] 编译 Token Desk…\n'
export MACOSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET"
"$SWIFTC" -swift-version 5 -Onone -parse-as-library \
  -target "$TARGET_ARCH-apple-macosx$DEPLOYMENT_TARGET" \
  "$SOURCE_DIR/QuotaModels.swift" \
  "$SOURCE_DIR/BrowserUsage.swift" \
  "$SOURCE_DIR/BrowserBridge.swift" \
  "$SOURCE_DIR/TokenDeskApp.swift" \
  -framework SwiftUI -framework AppKit -framework Network -framework UserNotifications \
  -o "$STAGE_APP/Contents/MacOS/TokenDesk"
chmod 755 "$STAGE_APP/Contents/MacOS/TokenDesk"

if [[ -f "$SOURCE_DIR/TokenDeskIcon.png" ]]; then
  /usr/bin/ditto --noqtn "$SOURCE_DIR/TokenDeskIcon.png" "$STAGE_APP/Contents/Resources/TokenDeskIcon.png" 2>/dev/null || cp "$SOURCE_DIR/TokenDeskIcon.png" "$STAGE_APP/Contents/Resources/TokenDeskIcon.png"
fi
if [[ -f "$SOURCE_DIR/TokenDesk.icns" ]]; then
  /usr/bin/ditto --noqtn "$SOURCE_DIR/TokenDesk.icns" "$STAGE_APP/Contents/Resources/TokenDesk.icns" 2>/dev/null || cp "$SOURCE_DIR/TokenDesk.icns" "$STAGE_APP/Contents/Resources/TokenDesk.icns"
else
  echo '⚠️ 缺少 TokenDesk.icns；App 仍可安装，但 Finder 可能显示默认图标。'
fi

printf '[3/5] 清理下载标记并签名…\n'
# Clear all extended attributes from this locally generated app, not just
# com.apple.quarantine. This also avoids downloaded-source provenance being
# carried into the app bundle on newer macOS releases.
/usr/bin/xattr -cr "$STAGE_APP" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$STAGE_APP"
/usr/bin/codesign --verify --deep --strict "$STAGE_APP"

printf '[4/5] 安装到 ~/Applications…\n'
/usr/bin/pkill -x TokenDesk >/dev/null 2>&1 || true
for attempt in {1..15}; do
  if ! /usr/bin/pgrep -x TokenDesk >/dev/null 2>&1; then break; fi
  /bin/sleep 0.2
done
if /usr/bin/pgrep -x TokenDesk >/dev/null 2>&1; then
  echo '旧版 TokenDesk 仍在运行。请从菜单栏退出后重新安装。'
  exit 7
fi

if [[ -d "$TARGET_APP" ]]; then
  BACKUP="$TARGET_DIR/TokenDesk.backup.$(date +%Y%m%d%H%M%S).app"
  mv "$TARGET_APP" "$BACKUP"
fi
mv "$STAGE_APP" "$TARGET_APP"

# Final-path cleanup + re-sign. Doing this after the move is intentional.
/usr/bin/xattr -cr "$TARGET_APP" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$TARGET_APP"
/usr/bin/codesign --verify --deep --strict "$TARGET_APP"

# Stable Chrome extension install.
if [[ -d "$SOURCE_DIR/Chrome_Extension" ]]; then
  EXT_FOLDER="$HOME/Library/Application Support/TokenDesk/Chrome_Extension"
  EXT_PARENT="$(dirname "$EXT_FOLDER")"
  EXT_STAGE="$EXT_PARENT/Chrome_Extension.new.$$"
  mkdir -p "$EXT_PARENT"
  rm -rf -- "$EXT_STAGE"
  mkdir -p "$EXT_STAGE"
  cp -R "$SOURCE_DIR/Chrome_Extension/." "$EXT_STAGE/"
  /usr/bin/xattr -cr "$EXT_STAGE" 2>/dev/null || true
  rm -rf -- "$EXT_FOLDER"
  mv "$EXT_STAGE" "$EXT_FOLDER"
  echo "Chrome 扩展目录：$EXT_FOLDER"
fi

printf '[5/5] 首次启动…\n'
# Do NOT use `open` for the first launch. `open` invokes LaunchServices and
# Gatekeeper's downloaded-app path. The user has explicitly run this installer
# in Terminal, so start the locally-built executable directly after xattr clear.
LAUNCH_LOG="$HOME/Library/Logs/TokenDesk_launch.log"
mkdir -p "$(dirname "$LAUNCH_LOG")"
/usr/bin/nohup "$TARGET_APP/Contents/MacOS/TokenDesk" >"$LAUNCH_LOG" 2>&1 &
LAUNCH_PID=$!
/bin/sleep 1.2

if /bin/kill -0 "$LAUNCH_PID" 2>/dev/null || /usr/bin/pgrep -x TokenDesk >/dev/null 2>&1; then
  echo '✅ TokenDesk 已启动。'
else
  echo '⚠️ App 已安装，但首次进程没有保持运行。'
  echo '启动日志：'
  /usr/bin/tail -n 20 "$LAUNCH_LOG" 2>/dev/null || true
  echo '如果系统仍提示无法验证，请到 系统设置 → 隐私与安全性 → 仍要打开。'
fi

if [[ -n "$BACKUP" && -d "$BACKUP" ]]; then
  rm -rf -- "$BACKUP"
fi

printf '\n✅ 安装完成\n'
printf '应用：%s\n' "$TARGET_APP"
printf '版本：'
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TARGET_APP/Contents/Info.plist" 2>/dev/null || true
printf '\nChrome 扩展：~/Library/Application Support/TokenDesk/Chrome_Extension\n'
printf '说明：此版本是本机编译 + 本机 ad-hoc 签名，不是 Developer ID 公证发行版。\n'
printf '安装器已清除生成 App 的下载扩展属性，并直接启动本机可执行文件。\n'
printf '日志：%s\n' "$LOG"
