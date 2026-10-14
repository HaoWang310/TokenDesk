# TokenDesk · macOS + Windows

TokenDesk 是面向 macOS 与 Windows 的 ChatGPT Work / Codex 剩余额度与运行任务监控器。

主数据链路只有一条：

**Chrome 后台主动查询 → 本机 TokenDesk → 菜单栏 / 浮窗 / 额度历史**

## Windows v1.2.7

Windows v1.2.7 保留四类额度提醒，并新增每日使用时间、一周柱状统计和运行任务模型显示。

Windows 第一版已经加入同一 GitHub 仓库：

- Windows 10 2004（19041）及以上，推荐 Windows 11；
- 普通 Intel / AMD 电脑使用 `win-x64`；
- Windows on ARM 使用 `win-arm64`；
- .NET 8 + WPF 原生桌面程序，发布包为自包含版本，无需另外安装 .NET；
- 右下角系统托盘常驻；
- 5 小时 / 每周额度、重置时间和 7 天历史；
- 运行任务区分「思考 / 工作」；
- Chrome / Edge 共用同一份 Chromium 扩展；
- 本地桥接仍只监听 `127.0.0.1:18743`。

Windows 详细说明见 [Windows/README.md](Windows/README.md)。

## macOS v1.8.4 更新

- 统计每天 ChatGPT 主动使用时间；
- 使用时间定义为：ChatGPT 标签页处于前台，并且最近 5 分钟内有键盘、鼠标、滚动等交互；
- 多个 ChatGPT 标签页不会重复累计；
- 本周（周一至周日）“每日使用时间”柱状图，周一 00:00 从零开始；
- 本周（周一至周日）“每日用量”柱状图，周一清零本地统计；这里的用量是每周剩余额度当日下降的百分点，不是 Token 数；
- 正在“思考 / 工作”的任务旁识别新版 ChatGPT 的模型选项，支持 GPT-6 等完整模型名称；仅检测到 Instant / Thinking / Pro 等档位时显示“模式”，不猜测具体模型；


- 5 小时额度剩余 20% 或以下时发送系统提醒；
- 每周额度剩余 20% 或以下时发送系统提醒；
- 5 小时额度刷新时发送系统提醒；
- 每周额度刷新时发送系统提醒；
- 同一额度周期只提醒一次，避免重复通知；

- 同一套安装包支持 Intel x86_64 与 Apple Silicon arm64；
- 最低支持 macOS 12 Monterey，兼容 macOS 13 及更新版本；
- 安装时自动识别当前架构并本机编译；
- 要求 Swift 5.5+，旧 Command Line Tools 会给出明确提示；
- 移除 Swift 5.7 简写可选绑定，提升 Monterey / Intel 兼容性；

- 最低支持 macOS 12 Monterey；
- 支持 Intel x86_64 本机编译；
- 修复部分 Swift 编译器对 BrowserBridge 闭包捕获要求显式 `self` 的错误；

- 运行任务区分为 **思考** 与 **工作** 两种状态；
- 页面显示“正在思考 / Thinking”时显示“思考”；
- 页面显示“正在工作 / Working / Running / Researching / Generating / Processing / 执行中”等状态时显示“工作”；
- 多任务会汇总为例如“思考 2 · 工作 1”；
- 任务完成、停止、关闭标签页或失联后自动移除；
- 任务心跳按状态动态刷新：运行时更频繁、空闲时降低刷新频率；
- 任务同步缓冲上限提高，避免大量并行任务或较长 URL 时同步失败；
- 额度监控、自适应历史图表、配对和本机 7 天历史逻辑保持不变。

## 保留功能

- 5 小时剩余额度；
- 每周剩余额度；
- 重置时间 / 可用重置次数；
- 自适应额度历史曲线：不足 24 小时时自动展开实际记录时长，满 24 小时后显示最近 24 小时；
- 历史曲线增加采样点、起始时间和“现在”标记；
- 最近记录和最多 7 天本机历史；
- Chrome 后台约每 30 秒主动查询；
- Chrome 运行并保持 ChatGPT 登录即可，无需打开 ChatGPT 或“设置 → 用量”页面；
- 配对码保存在 Chrome 扩展本地存储中，正常重启 Chrome / Mac 不需要重新配对。

## 已彻底移除

- Work / Codex CLI 连接区；
- Codex CLI 探测、启动和 `account/rateLimits/read`；
- `~/.codex/sessions` / `archived_sessions` 扫描；
- 本机 Token 输入 / 输出 / 缓存统计；
- OpenAI Admin Usage API / API Key / 钥匙串统计逻辑；
- 旧 Codex 15 秒轮询。

## 安装

1. 解压 ZIP。
2. 推荐在终端直接运行 `bash "/完整路径/安装到Mac.command"`。不要先单独输入 `bash` 再直接执行 `.command` 文件。
3. Chrome 打开 `chrome://extensions`。
4. 找到 **TokenDesk 网页额度同步** → **重新加载**，确认版本为 `1.8.6`。
5. 原配对码通常继续有效；若显示未配对，从 Mac TokenDesk 设置中重新复制并保存即可。
6. 点一次扩展里的 **立即后台查询** 验证。

## 隐私

Chrome 登录凭据、Cookie、密码、聊天正文和 Authorization header 不会发送到 TokenDesk。Mac App 只接收净化后的额度百分比、重置信息、来源类型和同步时间。

- macOS v1.8.4 / Windows v1.2.7：依据实测 ChatGPT 网络响应的 resolved_model_slug（如 gpt-6-thinking），直接从 conversation 事件流提取模型名称；只向本机桌面端传输模型标签，不保存或传输聊天正文。扩展更新至 v1.8.6 后必须刷新 ChatGPT 标签页；此协议未来可能改变。
- macOS v1.8.3 / Windows v1.2.6：修复 Chrome 扩展重新加载后，已打开的 ChatGPT 页面继续运行旧脚本并报告 extract.js 消息错误；新版 v1.8.5 安全处理消息回调和失效的扩展上下文。更新后必须重新加载扩展并刷新 ChatGPT 页面。
- macOS v1.8.2 / Windows v1.2.5：新增 Chrome 扩展模型诊断功能，能检查各 ChatGPT 标签页的脚本版本、选择器状态及模型标签；在 Work 页面未提供可访问模型名称时保留明确的未知状态，不虚构模型；安装后务必更新扩展至 v1.8.4 并刷新网页。
- macOS v1.8.1 / Windows v1.2.4：同步新版 ChatGPT 模型/模式识别，Mac 与 Windows 均显示周一至周日的本周统计，周一 00:00 本地统计清零；保留额度提醒单周期最多一次。
- v1.8.0 / Windows v1.2.0：继续保留空闲 Work 模式误判修复，并新增使用统计和模型显示。
