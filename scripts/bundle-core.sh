#!/bin/zsh
# 把 core 的构建产物和生产依赖装进 src-tauri/resources/core，供 tauri build 打进 .app/Contents/Resources/core。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/apps/desktop/src-tauri/resources/core"
rm -rf "$OUT"
pnpm --dir "$ROOT" --filter @friday/core build
# --offline：依赖都在本地 store，联网只会在代理不通时把打包挂死（2026-09-10 卡过 10 分钟）；真缺包就该报错
pnpm --dir "$ROOT" --filter @friday/core deploy --prod --legacy --offline --config.node-linker=hoisted "$OUT"
# node-pty 的 spawn-helper 复制后会丢可执行位，没有它 PTY 起不来。
find "$OUT/node_modules" -path "*node-pty*" -name spawn-helper -type f -print0 | xargs -0 chmod +x
echo "core bundled -> $OUT ($(du -sh "$OUT" | cut -f1))"
