# TokenDesk

A lightweight **macOS + Windows** monitor for **ChatGPT Work / Codex usage limits**.

> **Unofficial project.** TokenDesk is not affiliated with or endorsed by OpenAI. It relies on ChatGPT web behavior/internal endpoints that may change without notice.

## What it does

TokenDesk shows quota and running-task status on macOS and Windows:

- 5-hour remaining usage quota
- weekly remaining usage quota
- reset times and available resets when reported by ChatGPT
- recent quota history stored locally on the Mac
- last-sync and stale-data state
- daily active ChatGPT usage time
- seven-day bar charts for active time and weekly-quota consumption
- current model label beside active Thinking / Working tasks when ChatGPT exposes it in the UI

Current data path:

**Chrome background query → local TokenDesk app → menu bar / floating panel / quota history**

After the first pairing, Chrome can stay in the background. You do **not** need to keep ChatGPT or the Usage page open.

## Current macOS version: v1.8.2

Both desktop apps now support quota notifications:
- 5-hour quota at 20% remaining or below
- weekly quota at 20% remaining or below
- 5-hour quota reset
- weekly quota reset

v1.8.1 synchronizes ChatGPT's current composer model/mode selector support (GPT-6 and explicitly labeled modes) and displays local Monday-Sunday active usage totals that reset each Monday at midnight, without changing ChatGPT's quota reset time.

“Active time” means a ChatGPT tab is in the foreground and has had user interaction within the last five minutes. “Daily usage” is the drop in the weekly remaining quota, measured in percentage points; it is not a token count.

v1.8.0 uses one architecture-adaptive installer for Intel x86_64 and Apple Silicon arm64, with a macOS 12.0 deployment target and Swift 5.5+ source compatibility.

v1.8.0 adds macOS 12 Monterey / Intel x86_64 local-build compatibility and fixes Swift closure-capture compilation on older toolchains.

- Chrome background polling, about every 30 seconds
- no Codex CLI, Node.js, or npm dependency
- no local `.codex` log scanning
- no token-count dashboard
- no Admin Usage API key
- local 7-day quota history
- adaptive history chart: expands early data instead of compressing it into a fixed 24-hour axis
- running-task monitor across open ChatGPT Chrome tabs; completed/stopped tasks disappear automatically
- chart sample dots plus start-time / “now” labels
- stale-data detection when Chrome stops syncing
- local macOS build/install flow
- adaptive macOS menu-bar icon

## Windows v1.2.5

The Windows version is under `Windows/` and is built with **.NET 8 + WPF**.

- Windows 10 2004 (19041) or later
- Windows 11 recommended
- `win-x64` for standard Intel / AMD PCs
- `win-arm64` for Windows on ARM
- self-contained build: no separate .NET installation required
- system tray resident app
- 5-hour / weekly quota, reset times and 7-day local history
- running-task monitor with separate **Thinking / Working** counts and model labels
- seven-day active-time and daily-quota-consumption bar charts
- Chrome and Edge can load the bundled Chromium extension
- loopback bridge remains bound to `127.0.0.1:18743`

GitHub Actions automatically builds both Windows architectures. See [Windows/README.md](Windows/README.md).

## Install


### 1. Download the repository

Use GitHub **Code → Download ZIP**, or clone it:

```bash
git clone https://github.com/HaoWang310/TokenDesk.git
cd TokenDesk
```

### 2. Install the macOS app

Run the installer through Terminal:

```bash
bash "/full/path/to/TokenDesk/安装到Mac.command"
```

The app installs to:

```text
~/Applications/TokenDesk.app
```

The installer builds the Swift app locally and uses an ad-hoc local signature. This repository is **not** an Apple Developer ID / notarized distribution.

### 3. Load the Chrome extension

The installer copies the extension to:

```text
~/Library/Application Support/TokenDesk/Chrome_Extension
```

Open:

```text
chrome://extensions
```

Turn on **Developer mode**, choose **Load unpacked**, and select that folder. If the extension is already installed, click **Reload**.

### 4. Pair once

Copy the pairing code from TokenDesk on the Mac, paste it into the Chrome extension, and click **保存配对**.

Pairing normally survives Chrome and macOS restarts. You need to pair again only if extension storage is cleared, the extension is reinstalled, the Chrome profile changes, or the pairing code is reset.

## Privacy

The Mac app receives only normalized quota information such as percentages, reset metadata, source type, and sync time.

The Mac app does **not** receive your ChatGPT password, cookies, chat text, or browser authorization token. Authentication stays inside Chrome.

The extension has host access to ChatGPT so it can query the usage endpoint using the browser's existing login session. Review the source before installing if this matters for your security model.

## Repository layout

```text
TokenDeskApp.swift                 macOS SwiftUI/AppKit UI
Windows/                           Windows .NET 8 / WPF app
BrowserBridge.swift                loopback Chrome → Mac bridge
BrowserUsage.swift                 sanitized quota parsing
QuotaModels.swift                  quota models
Info.plist                         macOS app metadata
Chrome_Extension/                  Chrome Manifest V3 extension
tests/                             parser / bridge / background tests
安装到Mac.command                  local macOS installer
修复首次启动.command               local first-launch repair helper
只更新Chrome扩展.command           extension-only updater
README_中文.md                     Chinese documentation
先读我_网页同步安装指南.md          Chinese install guide
版本修复说明_*.txt                 version notes
```

## Requirements

- macOS 12 Monterey or later (Mac version)
- Google Chrome
- an active ChatGPT login in Chrome
- Apple Command Line Tools / Swift compiler for the local build

No OpenAI API key is required for the quota-monitoring workflow.

## Notes

ChatGPT usage limits and internal web APIs can change. If the upstream endpoint or response format changes, TokenDesk may need an update.

Chinese documentation: [README_中文.md](README_%E4%B8%AD%E6%96%87.md)

- v1.8.0 / Windows v1.2.0: fixes idle ChatGPT Work-mode tabs being falsely reported as active Working tasks.
