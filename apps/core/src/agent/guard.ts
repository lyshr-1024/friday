import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { DEFAULT_PROTECTED } from "../memory/projects.js";

// git 全局选项（-C <dir>、--no-pager、-c key=value…）可以插在 git 和子命令之间，是常见写法不是对抗行为，
// 正则得把它们跳过去，不然 "git -C /path push" 这种就绕过了下面所有拦截。
const GIT_OPT = "(?:-[a-zA-Z](?:\\s+\\S+)?|--[\\w-]+(?:=\\S+)?)";
const gitCmd = (sub: string) => `\\bgit\\s+(?:${GIT_OPT}\\s+)*${sub}`;

export const PUSH_RE = `${gitCmd("push")}\\b`;
export const PUSH_WHY = "推送只拦保护分支和 tag，开发分支怎么推都行；准备段和只读任务不推送";

// 自主任务无人看着，守卫只守两样：保护分支（推 / 切过去 / 删 / 改名）和非 git 的危险命令。
// 开发分支上 rebase / merge / reset --hard / 强推 / 删远端全放——用户 2026-10-21 定的：那些都是开发分支，他不关心。
// --dangerously-skip-permissions 会让 settings 里的 permissions.deny 失效，所以走 PreToolUse hook。
export const FORBIDDEN: Array<[pattern: string, why: string]> = [
  ["\\bsudo\\b", "自主任务不提权"],
  ["\\brm\\s+-[a-zA-Z]*[rf][a-zA-Z]*\\s+(/|~)(\\s|$)", "危险的递归删除"],
];

/** 名单里一项变正则源：`*` 通配，裸名也盖住 `名/…`（release 盖住 release/saas） */
export function branchPattern(p: string): string {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return p.includes("*") ? esc : `${esc}(?:/.*)?`;
}

export function isProtected(branch: string, patterns: string[]): boolean {
  return patterns.some((p) => new RegExp(`^${branchPattern(p)}$`).test(branch));
}

/** 本地就能判的保护分支规则：切过去、删掉、改名。推送要看目标分支和仓库默认分支，由 core 判（pushVerdict）。 */
export function protectedRules(patterns: string[]): Array<[pattern: string, why: string]> {
  if (!patterns.length) return [];
  const alt = `(?:${patterns.map(branchPattern).join("|")})`;
  const why = `保护分支（${patterns.join("、")}）不许切过去、删掉或改名`;
  return [
    [`${gitCmd("(?:checkout|switch)")}\\s+${alt}(?=\\s|$)`, why],
    [`${gitCmd("branch")}\\s+-[a-zA-Z]*[dDmM][a-zA-Z]*\\s+${alt}(?=\\s|$)`, why],
  ];
}

/**
 * 已登记工具的命令行：只在命令位置（行首、; && || | ( 反引号 $( 之后，可带路径，或 npx / pnpm dlx / bunx 的第一个参数）才拦，作参数或文件名不拦。
 * 包装命令后面也算命令位置：sh/bash/zsh -c、xargs、nohup、command、exec、watch、env、time（可带路径和选项）；名字加引号或反斜杠一样认。
 */
export function binaryRules(binaries: string[]): Array<[pattern: string, why: string]> {
  return binaries.map((b) => {
    const esc = b.replace(/[.+?^${}()|[\]\\*-]/g, "\\$&");
    const shell = "(?:\\S*/)?(?:sh|bash|zsh)\\s+(?:-\\w+\\s+)*-\\w*c\\s+[\"']?";
    const wrapper = "(?:\\S*/)?(?:xargs|nohup|command|exec|watch|env|time)\\s+(?:-\\S+\\s+(?:\\d+\\s+)?)*";
    const lead = `(?:^|[;&|(\`{\\n]|\\$\\(|\\b(?:then|do|else)\\b)\\s*(?:${shell}|${wrapper}|[A-Za-z_]\\w*=\\S*\\s+)*(?:(?:npx|bunx|pnpm\\s+dlx)\\s+(?:-\\S+\\s+)*)?`;
    return [`${lead}["'\\\\]?(?:\\S*/)?${esc}["']?(?=\\s|$|[;&|)\`])`, `${b} 已登记为 Friday 的外部工具，经 tool_call 调用，不要在 Bash 里直接跑`];
  });
}

export function forbidden(command: string, patterns: string[] = DEFAULT_PROTECTED, binaries: string[] = []): string | undefined {
  for (const [pattern, why] of [...FORBIDDEN, ...protectedRules(patterns), ...binaryRules(binaries)]) if (new RegExp(pattern).test(command)) return why;
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

export type PushVerdict = { allow: true; dir: string; branches: string[] } | { allow: false; why: string };

/**
 * 自主任务的 git push 放不放：目标是开发分支就放（强推、删远端、一条命令推几个都行）；
 * 目标是保护分支（项目名单或默认名单，外加仓库自己的默认分支 origin/HEAD）、推 tag、--all / --mirror 拦。判断不了的也拦。
 * git 查询从外面传进来：currentBranch(dir) 当前分支（游离 HEAD 给空），defaultBranch(dir) origin/HEAD 指向的分支。
 */
export function pushVerdict(
  command: string,
  cwd: string | undefined,
  git: { currentBranch: (dir: string) => string; defaultBranch: (dir: string) => string | undefined },
  patterns: string[] = DEFAULT_PROTECTED,
): PushVerdict {
  const segs = command.split(/&&|\|\||;|\|/).filter((s) => /\bgit\b[^]*\bpush\b/.test(s));
  if (!segs.length) return { allow: false, why: "看不懂这条 push" };
  const dir = pushDir(command, cwd);
  if (!dir) return { allow: false, why: "看不出在哪个仓库推" };
  const current = git.currentBranch(dir);
  const main = git.defaultBranch(dir);
  const guarded = (b: string) => isProtected(b, patterns) || b === main;
  const branches: string[] = [];
  for (const seg of segs) {
    const words = seg.trim().match(/'[^']*'|"[^"]*"|\S+/g)!.map((w) => w.replace(/^(['"])(.*)\1$/, "$2"));
    const args = words.slice(words.indexOf("push") + 1);
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (/^--(all|mirror|branches)$/.test(a)) return { allow: false, why: "不许一次推所有分支，里面有保护分支" };
      if (/^--(tags|follow-tags)$/.test(a)) return { allow: false, why: "不许推 tag（可能触发发布）" };
      if (/^-[a-zA-Z]+$/.test(a)) {
        if (a.includes("o")) i++;
        continue;
      }
      if (/^--(push-option|repo|receive-pack|exec)$/.test(a)) { i++; continue; }
      if (a.startsWith("-")) continue;
      // 重定向不是 refspec：`2>&1`、`>/dev/null`；`2> log` 这种分开写的连目标一起跳过
      if (/^(\d*|&)[<>]/.test(a)) {
        if (/^(\d*|&)[<>]{1,2}$/.test(a)) i++;
        continue;
      }
      positional.push(a);
    }
    const refspecs = positional.slice(1);
    for (const r of refspecs.length ? refspecs : ["HEAD"]) {
      const spec = r.replace(/^\+/, "");
      const [src, dst] = spec.includes(":") ? (spec.split(":", 2) as [string, string]) : [spec, spec];
      if (/^refs\/tags\//.test(dst) || /^refs\/tags\//.test(src)) return { allow: false, why: "不许推 tag（可能触发发布）" };
      const name = (dst === "HEAD" || dst === "@" ? current : dst).replace(/^refs\/heads\//, "");
      if (!name) return { allow: false, why: "当前不在分支上（游离 HEAD），不知道推到哪" };
      if (guarded(name)) return { allow: false, why: `不许推 ${name}（保护分支），要进它走 MR` };
      branches.push(name);
    }
  }
  return { allow: true, dir, branches };
}
