#!/bin/zsh
# 把 core 的构建产物和生产依赖装进 src-tauri/resources/core，供 tauri build 打进 .app/Contents/Resources/core。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/apps/desktop/src-tauri/resources/core"
rm -rf "$OUT"
pnpm --dir "$ROOT" --filter @friday/core build
# --offline：依赖都在本地 store，联网只会在代理不通时把打包挂死（2026-09-10 卡过 10 分钟）；真缺包就该报错
pnpm --dir "$ROOT" --filter @friday/core deploy --prod --legacy --offline --config.node-linker=hoisted "$OUT"
# --offline 解析不到平台可选依赖，Agent SDK 的原生 CLI 二进制（claude-agent-sdk-darwin-arm64）会被漏掉，
# 没有它 /ask 直接报 "Native CLI binary for darwin-arm64 not found"。从工作区的 store 里补进去，版本跟 SDK 对齐。
SDK_VER=$(node -p "require('$OUT/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version")
NATIVE="$OUT/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"
if [ ! -d "$NATIVE" ]; then
  SRC="$ROOT/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@$SDK_VER/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"
  if [ ! -d "$SRC" ]; then echo "缺 @anthropic-ai/claude-agent-sdk-darwin-arm64@$SDK_VER，先在主仓 pnpm install"; exit 1; fi
  cp -R "$SRC" "$NATIVE"
  echo "补入原生 CLI：claude-agent-sdk-darwin-arm64@$SDK_VER"
fi
[ -x "$NATIVE"/claude ] || [ -n "$(find "$NATIVE" -maxdepth 2 -type f -perm +111 | head -1)" ] || { echo "原生 CLI 二进制不可执行"; exit 1; }
# node-pty 的 spawn-helper 复制后会丢可执行位，没有它 PTY 起不来。
find "$OUT/node_modules" -path "*node-pty*" -name spawn-helper -type f -print0 | xargs -0 chmod +x
echo "core bundled -> $OUT ($(du -sh "$OUT" | cut -f1))"
