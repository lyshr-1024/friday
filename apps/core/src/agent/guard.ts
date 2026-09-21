// git 全局选项（-C <dir>、--no-pager、-c key=value…）可以插在 git 和子命令之间，是常见写法不是对抗行为，
// 正则得把它们跳过去，不然 "git -C /path push" 这种就绕过了下面所有拦截。
const GIT_OPT = "(?:-[a-zA-Z](?:\\s+\\S+)?|--[\\w-]+(?:=\\S+)?)";
const gitCmd = (sub: string) => `\\bgit\\s+(?:${GIT_OPT}\\s+)*${sub}`;

// 自主任务无人看着，这些命令一律拦下：要么不可逆，要么该由用户审核后 Friday 自己执行。
// --dangerously-skip-permissions 会让 settings 里的 permissions.deny 失效，所以走 PreToolUse hook。
export const FORBIDDEN: Array<[pattern: string, why: string]> = [
  [`${gitCmd("push")}\\b`, "推送要你审核"],
  [`${gitCmd("merge")}\\b`, "合并由 Friday 在你审核通过后执行"],
  [`${gitCmd("rebase")}\\b`, "变基会改写历史"],
  [`${gitCmd("reset")}\\s+--hard\\b`, "会丢掉未提交的改动"],
  [`${gitCmd("checkout")}\\s+(main|master)\\b`, "自主任务只在自己的分支上改"],
  ["\\bsudo\\b", "自主任务不提权"],
  ["\\brm\\s+-[a-zA-Z]*[rf][a-zA-Z]*\\s+(/|~)(\\s|$)", "危险的递归删除"],
];

export function forbidden(command: string): string | undefined {
  for (const [pattern, why] of FORBIDDEN) if (new RegExp(pattern).test(command)) return why;
  return undefined;
}

// 只读任务（回答别人的问题）不许改任何文件。--dangerously-skip-permissions 让 permissions.deny 失效，
// 而 Bash 守卫的 matcher 只认 Bash，所以改文件的工具要单独挂一条 hook。
export const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

export function forbiddenTool(name: string): string | undefined {
  return WRITE_TOOLS.includes(name) ? "这是只读任务，只查不改" : undefined;
}
