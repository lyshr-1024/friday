import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

// git 全局选项（-C <dir>、--no-pager、-c key=value…）可以插在 git 和子命令之间，是常见写法不是对抗行为，
// 正则得把它们跳过去，不然 "git -C /path push" 这种就绕过了下面所有拦截。
const GIT_OPT = "(?:-[a-zA-Z](?:\\s+\\S+)?|--[\\w-]+(?:=\\S+)?)";
const gitCmd = (sub: string) => `\\bgit\\s+(?:${GIT_OPT}\\s+)*${sub}`;

// 自主任务无人看着，这些命令一律拦下：要么不可逆，要么该由用户审核后 Friday 自己执行。
// --dangerously-skip-permissions 会让 settings 里的 permissions.deny 失效，所以走 PreToolUse hook。
export const PUSH_WHY = "只能推当前功能分支：不许强推、删远端分支、推主干 / 受保护分支或 tag";

export const FORBIDDEN: Array<[pattern: string, why: string]> = [
  [`${gitCmd("push")}\\b`, PUSH_WHY],
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

/**
 * push 命令实际在哪个目录跑：`git -C <路径> push`、`cd <路径> && git push`，都没有就是会话的 cwd。
 * Claude 可能跑到另一个仓库里改（2026-10-02 真事：任务挂 whale-console，改的是 fe-wealth-admin）。
 */
export function pushDir(command: string, cwd?: string): string | undefined {
  const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, "$2");
  const abs = (p: string) => {
    const q = unquote(p).replace(/^~(?=\/|$)/, homedir());
    return isAbsolute(q) ? q : cwd ? resolve(cwd, q) : undefined;
  };
  const at = command.search(/\bgit\b[^;&|]*\bpush\b/);
  if (at < 0) return cwd;
  const c = /^\bgit\s+-C\s+('[^']+'|"[^"]+"|\S+)[^;&|]*\bpush\b/.exec(command.slice(at));
  if (c) return abs(c[1]!);
  const cds = [...command.slice(0, at).matchAll(/(?:^|&&|;)\s*cd\s+('[^']+'|"[^"]+"|[^\s;&|]+)/g)];
  return cds.length ? abs(cds.at(-1)![1]!) : cwd;
}

/** 主干和常见的环境分支；仓库自己的默认分支（origin/HEAD）另外算 */
const PROTECTED = /^(main|master|develop|dev|sit|uat|test|staging|prod|production|release)(\/.*)?$/;

export type PushVerdict = { allow: true; dir: string; branches: string[] } | { allow: false; why: string };

/**
 * 自主任务的 git push 放不放：推当前功能分支（或显式写的功能分支）放行，建 MR 要用；
 * 强推、删远端分支、推 tag、--all / --mirror、推主干和受保护分支一律拦。判断不了的也拦。
 * git 查询从外面传进来：currentBranch(dir) 当前分支（游离 HEAD 给空），defaultBranch(dir) origin/HEAD 指向的分支。
 */
export function pushVerdict(command: string, cwd: string | undefined, git: { currentBranch: (dir: string) => string; defaultBranch: (dir: string) => string | undefined }): PushVerdict {
  const segs = command.split(/&&|\|\||;|\|/).filter((s) => /\bgit\b[^]*\bpush\b/.test(s));
  if (segs.length !== 1) return { allow: false, why: segs.length ? "一条命令里推了好几次，拆开来一次推一个分支" : "看不懂这条 push" };
  const dir = pushDir(command, cwd);
  if (!dir) return { allow: false, why: "看不出在哪个仓库推" };
  const words = segs[0]!.trim().match(/'[^']*'|"[^"]*"|\S+/g)!.map((w) => w.replace(/^(['"])(.*)\1$/, "$2"));
  const args = words.slice(words.indexOf("push") + 1);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (/^--(force|force-with-lease|force-if-includes)(=|$)/.test(a)) return { allow: false, why: "不许强推" };
    if (/^--(delete|prune)$/.test(a)) return { allow: false, why: "不许删远端分支" };
    if (/^--(all|mirror|branches)$/.test(a)) return { allow: false, why: "不许一次推所有分支" };
    if (/^--(tags|follow-tags)$/.test(a)) return { allow: false, why: "不许推 tag（可能触发发布）" };
    if (/^-[a-zA-Z]+$/.test(a)) {
      if (/[fd]/.test(a)) return { allow: false, why: a.includes("f") ? "不许强推" : "不许删远端分支" };
      if (a.includes("o")) i++;
      continue;
    }
    if (/^--(push-option|repo|receive-pack|exec)$/.test(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  const current = git.currentBranch(dir);
  const refspecs = positional.slice(1);
  const branches: string[] = [];
  for (const r of refspecs.length ? refspecs : ["HEAD"]) {
    if (r.startsWith("+")) return { allow: false, why: "不许强推" };
    const [src, dst] = r.includes(":") ? r.split(":", 2) as [string, string] : [r, r];
    if (!src) return { allow: false, why: "不许删远端分支" };
    if (/^refs\/tags\//.test(dst) || /^refs\/tags\//.test(src)) return { allow: false, why: "不许推 tag（可能触发发布）" };
    const name = (dst === "HEAD" || dst === "@" ? current : dst).replace(/^refs\/heads\//, "");
    if (!name) return { allow: false, why: "当前不在分支上（游离 HEAD），不知道推到哪" };
    branches.push(name);
  }
  const main = git.defaultBranch(dir);
  const guarded = branches.find((b) => PROTECTED.test(b) || b === main);
  if (guarded) return { allow: false, why: `不许推 ${guarded}（主干 / 受保护分支），要进主干走 MR` };
  return { allow: true, dir, branches };
}
