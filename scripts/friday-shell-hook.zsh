# source 到 .zshrc 后，每条命令结束把 cwd / 分支 / 命令 / 退出码上报给 Friday，
# 呼出模式判断「这个终端在哪个项目」用它，比窗口标题解析准。
# 失败必须静默、必须快——curl --max-time 0.3 且丢进后台，绝不能拖慢交互式 shell。
_friday_json_escape() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  print -r -- "$s"
}

_friday_report() {
  local exit_code=$?
  local cwd=$PWD
  local branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
  local cmd=$(fc -ln -1 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  local port=${FRIDAY_PORT:-7788}
  local body="{\"cwd\":\"$(_friday_json_escape "$cwd")\",\"branch\":\"$(_friday_json_escape "$branch")\",\"cmd\":\"$(_friday_json_escape "$cmd")\",\"exitCode\":$exit_code}"
  (curl -s -o /dev/null --max-time 0.3 -X POST "http://127.0.0.1:$port/activity" -H "content-type: application/json" -d "$body" >/dev/null 2>&1 &) 2>/dev/null
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _friday_report
