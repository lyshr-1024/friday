#!/bin/zsh
# 把浏览器里 Slack 的登录态存进 macOS 钥匙串（服务名 friday-slack），Friday 运行时读取，不落明文文件。
set -euo pipefail

echo "取法（Chrome / Safari 打开 app.slack.com 并登录后）："
echo "  1. 开发者工具 → Console，粘贴执行："
echo "     Object.values(JSON.parse(localStorage.localConfig_v2).teams)[0].token"
echo "     得到 xoxc- 开头的一串，就是 token。"
echo "  2. 开发者工具 → Application（Safari 叫 Storage）→ Cookies → https://app.slack.com → 找名为 d 的 cookie，值以 xoxd- 开头。"
echo

# 非交互环境（agent shell / 管道 / CI）里 read 拿不到输入，改用 macOS 输入框。
ask() {
  local prompt=$1 out
  if [[ -t 0 ]]; then
    read -rs "out?$prompt："; echo >&2
  else
    out=$(osascript -e "display dialog \"$prompt\" default answer \"\" with hidden answer with title \"Friday · Slack 登录态\"" -e 'text returned of result') || {
      echo "已取消" >&2; exit 1
    }
  fi
  print -r -- "$out"
}

# 逐项取值：校验通过就立刻写钥匙串，失败当场重问，已存好的跳过。
collect() {
  local account=$1 prefix=$2 label=$3 cur val
  cur=$(security find-generic-password -s friday-slack -a "$account" -w 2>/dev/null || true)
  if [[ "$cur" == ${prefix}* ]]; then
    echo "$label 已在钥匙串里（${cur:0:6}…），跳过。"
    return
  fi
  for _ in 1 2 3; do
    val=$(ask "粘贴 $label")
    val=${val//[$'\n\r\t ']/}          # 去掉粘贴时混进来的空白
    val=${val//\"/}                     # 去掉 Console 返回值的引号
    if [[ "$val" == ${prefix}* ]]; then
      security add-generic-password -U -s friday-slack -a "$account" -w "$val"
      echo "$label 已写入钥匙串。"
      return
    fi
    if [[ -z "$val" ]]; then
      echo "$label 是空的，再试一次。" >&2
    else
      echo "$label 应以 $prefix 开头，实际是 ${val:0:8}…，再试一次。" >&2
    fi
  done
  echo "$label 连试三次都不对，先退出。取好值再跑一遍这个脚本。" >&2
  exit 1
}

collect token  xoxc- "xoxc token"
collect cookie xoxd- "d cookie（xoxd-…）"

token=$(security find-generic-password -s friday-slack -a token -w)
cookie=$(security find-generic-password -s friday-slack -a cookie -w)
echo "验证："
curl -s -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $token" -H "Cookie: d=$cookie" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("ok") else "失败", d.get("user"), d.get("team"), d.get("error",""))'
