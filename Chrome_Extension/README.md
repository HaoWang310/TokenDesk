# TokenDesk Chrome Extension v1.8.0

- 首选：Chrome service worker 后台主动查询 ChatGPT 用量，约每 30 秒一次。
- 无需打开 ChatGPT 或“设置 → 用量”页面。
- 不请求 Chrome `cookies` API 权限。
- 如果用量端点需要短期 bearer token，只在 service worker 内存中临时使用，不发送到 Mac。
- Mac 只接收净化后的额度字段到 `http://127.0.0.1:18743/ingest`。
- 页面网络监听保留为备用来源。
- DOM 扫描默认关闭，仅在后台主动查询失败时临时启用约 2 分钟，然后自动关闭。


## v1.8.0 task monitor

The extension reports currently active ChatGPT web tasks across open Chrome tabs and distinguishes `thinking` from `working`. Completed, stopped, closed, or stale tasks are removed automatically. It reads only page title plus active UI state for this feature; chat message text is not sent to the Mac app.

- 修复空闲 Work 模式标签页被误判为“工作”的问题。

## v1.8.0 usage statistics

- Tracks active ChatGPT foreground time locally, with a 5-minute inactivity cutoff.
- Keeps seven days of daily active time and weekly-quota consumption points in Chrome local storage.
- Sends the currently selected ChatGPT model label with active tasks when the UI exposes it.
