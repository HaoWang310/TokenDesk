# TokenDesk Mac v1.7.5 macOS 通用兼容版

TokenDesk 是 macOS 菜单栏 ChatGPT Work / Codex 剩余额度监控器。

主数据链路只有一条：

**Chrome 后台主动查询 → 本机 TokenDesk → 菜单栏 / 浮窗 / 额度历史**

## v1.7.5 更新

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
4. 找到 **TokenDesk 网页额度同步** → **重新加载**，确认版本为 `1.7.5`。
5. 原配对码通常继续有效；若显示未配对，从 Mac TokenDesk 设置中重新复制并保存即可。
6. 点一次扩展里的 **立即后台查询** 验证。

## 隐私

Chrome 登录凭据、Cookie、密码、聊天正文和 Authorization header 不会发送到 TokenDesk。Mac App 只接收净化后的额度百分比、重置信息、来源类型和同步时间。
