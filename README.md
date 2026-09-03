# Friday

常驻 macOS 菜单栏的个人助理。有长期记忆，聚合待办，知道我在做什么项目，后续能自主拉起 Claude Code 干活。

- 壳：Tauri 2（Rust）
- 核心：Node.js sidecar，本地 HTTP `127.0.0.1:7788`
- 前端：React，Spotlight 风格浮窗
- 记忆库：`~/Library/Application Support/Friday/`（Markdown + SQLite）

## 开发

```sh
pnpm install
pnpm dev        # 启动桌面 app（含 sidecar）
pnpm dev:core   # 只启动 sidecar
```

需要 Node ≥ 22.5、pnpm 10、Rust stable、Xcode 命令行工具。

## 隐私

所有数据只在本机。`.env`、记忆库、token 不进仓库。核心 API 只监听本地回环地址。
