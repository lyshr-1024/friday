#!/bin/zsh
# 把 core 的构建产物和生产依赖装进 src-tauri/resources/core，供 tauri build 打进 .app/Contents/Resources/core。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/apps/desktop/src-tauri/resources/core"
rm -rf "$OUT"
pnpm --dir "$ROOT" --filter @friday/core build
# 按 lockfile 精确装、离线（依赖都在本地 store，联网只会在代理不通时挂死）。
# 不能用 --legacy：它不读 lockfile，离线会把 SDK 解析成 store 里最新版，而那版的原生 CLI 二进制
# （claude-agent-sdk-darwin-arm64，平台可选依赖）不在 store 里，打出的包 /ask 直接报找不到二进制。
pnpm --dir "$ROOT" --filter @friday/core deploy --prod --offline --config.inject-workspace-packages=true --config.node-linker=hoisted "$OUT"
[ -d "$OUT/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64" ] || { echo "包里缺 claude-agent-sdk-darwin-arm64，/ask 会起不来"; exit 1; }
echo "core bundled -> $OUT ($(du -sh "$OUT" | cut -f1))"
