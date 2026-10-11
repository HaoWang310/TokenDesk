# TokenDesk

A lightweight macOS menu-bar monitor for **ChatGPT Work / Codex usage limits**.

> **Unofficial project.** TokenDesk is not affiliated with or endorsed by OpenAI. It relies on ChatGPT web behavior/internal endpoints that may change without notice.

## What it does

TokenDesk keeps a small macOS menu-bar panel showing:

- 5-hour remaining usage quota
- weekly remaining usage quota
- reset times and available resets when reported by ChatGPT
- recent quota history (stored locally on the Mac)
- last sync state / stale-data state

The current data path is:

**Chrome background query → local TokenDesk app → menu bar / floating panel / quota history**

Chrome can stay in the background. After first pairing, you do **not** need to keep the ChatGPT Usage page open.

## v1.6.7

- stable local macOS install flow
- Chrome background polling (about every 30 seconds)
- no Codex CLI / npm dependency
- no local `.codex` log scanning
- no token-count dashboard or Admin Usage API key
- local 7-day quota history
- stale-data detection after the browser stops syncing
- fixed app icon and adaptive macOS menu-bar icon

## Installation

### 1. Download

Download `dist/TokenDesk_Mac_v1.6.7.zip` after the repository files are published.

### 2. Install the macOS app

Run the installer through Terminal:

```bash
bash "/full/path/to/TokenDesk_v1.6.7/安装到Mac.command"
```

The app installs to:

```text
~/Applications/TokenDesk.app
```

### 3. Load / reload the Chrome extension

Open:

```text
chrome://extensions
```

Enable **Developer mode**, load the unpacked extension from the folder shown by TokenDesk, or reload the existing **TokenDesk 网页额度同步** extension.

### 4. Pair once

Copy the pairing code from the TokenDesk Mac panel, paste it into the Chrome extension, and click **保存配对**.

Normally, pairing survives Chrome and macOS restarts. You only need to pair again if extension storage is cleared, the extension is reinstalled, the Chrome profile changes, or the pairing code is reset.

## Privacy

TokenDesk is designed so that the macOS app receives only normalized quota information such as percentages, reset metadata, source type, and sync time.

The macOS app does not receive your ChatGPT password, cookies, chat text, or browser authorization token. Authentication stays inside Chrome.

## Repository layout

```text
src/                macOS Swift source
chrome-extension/   Chrome Manifest V3 extension
scripts/             macOS install/update helpers
tests/               parser/bridge/background tests
assets/              app icons
docs/                Chinese documentation and changelogs
dist/                packaged macOS build bundle
```

## Requirements

- macOS 13 or later
- Google Chrome
- an active ChatGPT login in Chrome

No Node.js, npm, Codex CLI, or OpenAI API key is required for the current quota-monitoring workflow.

## Notes

ChatGPT usage limits and internal web APIs can change. If the upstream usage endpoint or response format changes, TokenDesk may need an update.

Chinese documentation: `docs/README_zh-CN.md`
