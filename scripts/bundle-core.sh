#!/bin/zsh
# 把 core 的构建产物和生产依赖装进 src-tauri/resources/core，供 tauri build 打进 .app/Contents/Resources/core。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/apps/desktop/src-tauri/resources/core"
rm -rf "$OUT"
pnpm --dir "$ROOT" --filter @friday/core build
pnpm --dir "$ROOT" --filter @friday/core deploy --prod --legacy --config.node-linker=hoisted "$OUT"
echo "core bundled -> $OUT ($(du -sh "$OUT" | cut -f1))"
