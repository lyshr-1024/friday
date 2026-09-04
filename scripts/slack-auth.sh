#!/bin/zsh
# 把浏览器里 Slack 的登录态存进 macOS 钥匙串（服务名 friday-slack），Friday 运行时读取，不落明文文件。
set -euo pipefail
echo "取法（Chrome / Safari 打开 app.slack.com 并登录后）："
echo "  1. 开发者工具 → Console，粘贴执行："
echo "     Object.values(JSON.parse(localStorage.localConfig_v2).teams)[0].token"
echo "     得到 xoxc- 开头的一串，就是 token。"
echo "  2. 开发者工具 → Application（Safari 叫 Storage）→ Cookies → https://app.slack.com → 找名为 d 的 cookie，值以 xoxd- 开头。"
echo
read -rs "token?粘贴 xoxc token："; echo
read -rs "cookie?粘贴 d cookie（xoxd-…）："; echo
[[ "$token" == xoxc-* ]] || { echo "token 应以 xoxc- 开头"; exit 1; }
[[ "$cookie" == xoxd-* ]] || { echo "cookie 应以 xoxd- 开头"; exit 1; }
security add-generic-password -U -s friday-slack -a token -w "$token"
security add-generic-password -U -s friday-slack -a cookie -w "$cookie"
echo "已写入钥匙串。验证："
curl -s -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $token" -H "Cookie: d=$cookie" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("ok") else "失败", d.get("user"), d.get("team"), d.get("error",""))'
