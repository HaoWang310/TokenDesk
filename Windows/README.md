# TokenDesk for Windows v1.1.0

Windows 10 / 11 原生桌面版本，复用 TokenDesk 的 Chrome 扩展与本机桥接协议。

## 功能

- Windows 系统托盘常驻；
- ChatGPT 5 小时 / 每周剩余额度；
- 5 小时剩余 20% 或以下提醒；
- 每周剩余 20% 或以下提醒；
- 5 小时额度刷新提醒；
- 每周额度刷新提醒；
- 额度重置时间与 7 天本机历史；
- 运行任务统计，并区分「思考 / 工作」；
- 最多统计 20 个活动任务，面板展开前 8 个；
- 任务完成、停止或失联后自动移除；
- Chrome / Edge 可加载同一份 Chromium 扩展；
- 配对码与历史只保存在本机；
- 本机桥接只监听 `127.0.0.1:18743`；
- 可选择登录 Windows 后自动启动到系统托盘。

## 系统要求

- Windows 10 2004（19041）或更高版本；
- 推荐 Windows 11；
- 发布包提供 `win-x64` 与 `win-arm64` 两个自包含版本，无需单独安装 .NET。

## 安装

1. 从 GitHub Actions 下载与你电脑匹配的发布包：
   - 常见 Intel / AMD Windows 电脑：`TokenDesk-Windows-win-x64`
   - Windows on ARM：`TokenDesk-Windows-win-arm64`
2. 解压后运行 `TokenDesk.exe`。
3. 点击「打开扩展文件夹」。
4. Chrome / Edge 扩展管理页打开开发者模式，选择「加载已解压的扩展程序」并选择 `Chrome_Extension` 文件夹。
5. 将 TokenDesk 面板中的 64 位配对码复制到浏览器扩展并保存。
6. Chrome 保持登录 ChatGPT，即可同步额度。

额度监控无需保持 ChatGPT 页面打开；运行任务监控需要对应 ChatGPT 网页标签页保持打开。

## 隐私

Windows 端只接收净化后的额度字段与任务元数据（标题、URL、运行阶段、时间）。不会从 Chrome 扩展传输 ChatGPT 对话正文、密码、Cookie 或 bearer token 到 TokenDesk 桌面端。
