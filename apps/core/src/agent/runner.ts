import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { TermSessionKind } from "@friday/shared";
import { config } from "../config.js";
import { handbookBlock } from "../memory/rules.js";
import { BRANCH_RULE, terminalBridgePrompt } from "./prompt.js";
import { HEADLESS_MODEL } from "./claude.js";
import { FORBIDDEN, PUSH_WHY, WRITE_TOOLS } from "./guard.js";
import { UNTRUSTED_NOTE, untrusted } from "./fence.js";
import { newSession, tmuxPath } from "./tmux.js";

const execFileP = promisify(execFile);

export const reportPath = (id: string) => join(runsDir(), `${id}.report.md`);
export const shotsDir = (id: string) => join(runsDir(), `${id}.shots`);

/** 自主任务的提示词：分支、测试、交付报告、截图，全部落在约定路径，Friday 事后解析进审核。 */
export function autonomousPrompt(id: string, task: string, project: string): string {
  const handbook = handbookBlock(project);
  return [
    `你在项目 ${project} 里替用户完成一项任务，用户事后只看交付报告审核，所以过程要可追溯。`,
    `用户的诉求（Friday 转达的原话，它没读过这个项目的代码，也没有项目的 skill）：${task}`,
    "开工前先调 friday_context 拿完整背景（原话、Slack 全文、关联工单、人物）。改哪里、怎么改、分几步由你自己看代码判断，别照搬转述。",
    "",
    "规则：",
    "1. 你已经在为这次任务准备好的 git worktree 里、在新分支上，直接开工；不要再建分支，不要回主仓操作。",
    "   开工先调 friday_progress 把当前分支名告诉 Friday（写成「在分支 xxx 上开工」）。",
    "   merge、rebase、reset --hard 会被 Friday 的守卫直接拒绝，不用试。push 也会被拦，但会挂到任务卡上等用户批准、由 Friday 代推，见第 7 条。",
    "2. 改完必须跑该项目的类型检查和测试（看 package.json / Makefile 决定命令），失败就修到通过；实在修不了在报告里写明。",
    `3. 如果改动涉及界面，用 agent-browser skill 打开对应页面截图，保存到目录 ${shotsDir(id)}/（png，文件名写清楚是哪个页面哪个状态），至少一张改动前后的对比。不是界面改动就不截图。`,
    `4. 最后把交付报告写到 ${reportPath(id)}，严格用下面的 Markdown 结构：`,
    "## 概要",
    "一句话说做了什么。",
    "## 改动",
    "- 每个文件一行：路径 — 改了什么",
    "## 测试",
    "- 每一步一行：跑了什么命令 / 做了什么操作 → 结果",
    "## 测试结果",
    "一句话：全部通过 / 哪些没过。",
    "## 请验证",
    "- 用户应该亲自确认的点，每行一条，写清楚打开哪里看什么。",
    "## 截图",
    "- 文件名 — 说明（没有就写 无）",
    "5. 全程不要问用户问题——用户不在终端前，问了没人答，会一直卡着。拿不准就按最保守的方式做并在报告里写明，让用户看报告时再定。",
    "6. 验证时要碰远端数据（canary / staging 接口写入、改配置）只碰工单里给的造数数据，没给就不写；改过的一律还原，还原步骤和回读结果写进报告的「测试过程」。生产环境一律不写。",
    "7. 提交后要建 MR 就先 git push 当前分支：守卫会拦下并挂一条推送待审，你不用等，在交付报告的「概要」里写明「推送待批准，批准后再建 MR」照常收尾。分支已经在远端的，按项目规范建 draft MR（项目有 harua-deploy 之类的 skill 就用它，否则用 glab / gh），链接写进「概要」。不要 merge，不要推主分支。",
    ...(handbook ? ["", "下面是用户在这个项目里定过的口径，跟任务冲突时以任务为准，其余一律照做：", handbook] : []),
    UNTRUSTED_NOTE,
  ].join("\n");
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function findClaude(): Promise<string> {
  // 只给开发验收用：指向一个假的 claude 脚本，复现终端问题不花 token
  if (process.env.FRIDAY_CLAUDE_BIN) return process.env.FRIDAY_CLAUDE_BIN;
  const { stdout } = await execFileP("/bin/zsh", ["-ilc", "whence -p claude"]).catch(() => ({ stdout: "" }));
  const path = stdout.trim().split("\n").pop() ?? "";
  if (!path.startsWith("/")) throw new Error("找不到 claude，请确认已安装 Claude Code 且在登录 shell 的 PATH 中");
  return path;
}

export const runsDir = () => join(config.dataDir, "runs");
export const jobLog = (id: string) => join(runsDir(), `${id}.log`);

/**
 * Stop hook：每轮回答结束，Claude Code 把 transcript 路径经 stdin 给这个脚本，
 * 脚本取最后一段 assistant 文本 POST 回 Friday，会话窗里的任务卡片就能显示终端里 Claude 刚说了什么。
 */
export function buildHookScript(id: string, port: number, nodePath = process.execPath): string {
  // tmux 里没有 nvm 的 PATH，所以 node 用 sidecar 自己的绝对路径；出错写到 <id>.hook.log。
  return [
    "#!/bin/zsh",
    `exec >>${shellQuote(join(runsDir(), `${id}.hook.log`))} 2>&1`,
    `${shellQuote(nodePath)} -e ${shellQuote(`
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  try {
    const { transcript_path, last_assistant_message, session_id, hook_event_name, source, tool_name, tool_input, message, notification_type, cwd } = JSON.parse(input);
    // Claude Code 2.1 起 Stop 事件直接给 last_assistant_message；老版本再回退到读 transcript。
    let text = (last_assistant_message || "").trim();
    if (!text && (!hook_event_name || hook_event_name === "Stop") && transcript_path && fs.existsSync(transcript_path)) {
      const lines = fs.readFileSync(transcript_path, "utf8").trim().split("\\n");
      for (let i = lines.length - 1; i >= 0 && !text; i--) {
        try {
          const row = JSON.parse(lines[i]);
          if (row.type !== "assistant") continue;
          const parts = (row.message && row.message.content) || [];
          text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\\n").trim();
        } catch {}
      }
    }
    if (!text && !session_id && !tool_name && !message) { console.error("nothing to post"); return; }
    fetch("http://127.0.0.1:${port}/jobs/${id}/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(text ? { text } : {}), ...(session_id ? { sessionId: session_id } : {}), ...(hook_event_name ? { event: hook_event_name } : {}), ...(source ? { source } : {}), ...(tool_name ? { toolName: tool_name } : {}), ...(tool_input ? { toolInput: JSON.stringify(tool_input).slice(0, 4000) } : {}), ...(message ? { message: String(message).slice(0, 1000) } : {}), ...(notification_type ? { notificationType: notification_type } : {}), ...(cwd ? { cwd: String(cwd).slice(0, 1000) } : {}) }) })
      .then((r) => console.error("posted", r.status))
      .catch((e) => console.error("post failed", e.message));
  } catch (e) { console.error("hook error", e.message); }
});`)}`,
    "",
  ].join("\n");
}

/** SessionStart 一开始就把 session id 回传，不然 Claude 第一轮没说完 Friday 就重启，这条任务就再也接不上了；Stop 每轮回传最后一段回答。 */
export function buildHookSettings(hookScript: string, guardScript?: string, readOnly = false): string {
  const hook = [{ hooks: [{ type: "command", command: shellQuote(hookScript), timeout: 10 }] }];
  // 交互式提问（选项题 / plan 确认）不会发 Stop，PTY 也安静，不接这两个 hook 就感知不到它在等人
  const asking = [{ matcher: "AskUserQuestion|ExitPlanMode", hooks: hook[0]!.hooks }];
  // 自主任务多挂一条 Bash 守卫；settings 的 permissions.deny 在 --dangerously-skip-permissions 下不生效，hook 生效
  const guard = guardScript ? [{ matcher: "Bash", hooks: [{ type: "command", command: shellQuote(guardScript), timeout: 10 }] }] : [];
  // 自主任务里弹选择题 / plan 确认没人会答，会一直卡着：直接拒掉，让它按提示词第 5 条
  // 「拿不准就按最保守的方式做并在报告里写明」往下走。交互式终端不拦——你就在那儿。
  const refuseAsking = guardScript
    ? [{
        matcher: "AskUserQuestion|ExitPlanMode",
        hooks: [{
          type: "command",
          command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"这是无人值守的自主任务，没人能回答。按最保守的做法继续，把拿不准的点写进交付报告的「请验证」。"}}'`,
          timeout: 5,
        }],
      }]
    : [];
  const refuseWrite = readOnly
    ? [{
        matcher: WRITE_TOOLS.join("|"),
        hooks: [{
          type: "command",
          command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"这是只读任务：只查代码回答问题，不要改任何文件。把结论写进报告。"}}'`,
          timeout: 5,
        }],
      }]
    : [];
  const askHooks = guardScript ? refuseAsking : asking;
  return JSON.stringify(
    { hooks: { SessionStart: hook, UserPromptSubmit: hook, Stop: hook, PreToolUse: [...guard, ...refuseWrite, ...askHooks], PostToolUse: guardScript ? [] : asking, Notification: hook } },
    null,
    2,
  );
}

// 见 env.ts cleanEnv：tmux 里拉起的 claude 同样会继承这些变量
const UNSET_CLAUDE_ENV = "unset CLAUDECODE CLAUDE_PID $(env | sed -n 's/^\\(CLAUDE_CODE_[A-Z_]*\\)=.*/\\1/p') 2>/dev/null";

/** Claude Code 的 transcript 放在 ~/.claude/projects/<cwd 里所有非字母数字换成 ->/<session>.jsonl */
export function transcriptPath(dir: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** 写 Stop hook 脚本与 --settings 文件；每次启动/重开都重写，保证用的是当前版本的 hook。 */
/**
 * 自主任务的 PreToolUse 守卫：每条 Bash 命令过一遍 guard.ts 的黑名单，命中就 deny。
 * settings 里的 permissions.deny 在 --dangerously-skip-permissions 下不生效，hook 生效。
 */
export function buildGuardScript(nodePath = process.execPath, pushUrl?: string): string {
  return [
    "#!/bin/zsh",
    `${shellQuote(nodePath)} -e ${shellQuote(`
const rules = ${JSON.stringify(FORBIDDEN)};
const pushUrl = ${JSON.stringify(pushUrl ?? "")};
let input = "";
let done = false;
const decide = () => {
  if (done) return;
  done = true;
  let cmd = "";
  let cwd = "";
  try { const j = JSON.parse(input); cmd = String((j.tool_input || {}).command || ""); cwd = String(j.cwd || ""); } catch {}
  const hit = rules.find(([p]) => new RegExp(p).test(cmd));
  const asked = Boolean(hit && pushUrl && hit[1] === ${JSON.stringify(PUSH_WHY)});
  if (asked) fetch(pushUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd.slice(0, 1000), cwd }), signal: AbortSignal.timeout(3000) }).catch(() => {});
  const reason = asked
    ? "推送已挂到 Friday 任务卡上等用户批准，批准后由 Friday 代推（只推当前分支到 origin）。不要重试推送，也不要让用户自己去推。终端还开着的话，批准后你会收到「已推送」再接着做（比如建 MR）；无人值守的运行就在交付报告里写明「推送待批准」，照常收尾。"
    : "Friday 自主任务禁止这条命令（" + (hit ? hit[1] : "") + "）。换个做法，或在交付报告里写明卡在这里。";
  process.stdout.write(hit ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) : "{}");
};
process.stdin.on("data", (d) => (input += d)).on("end", decide);
setTimeout(decide, 2000).unref();`)}`,
    "",
  ].join("\n");
}

export interface ClaudeFiles {
  settings: string;
  mcp: string;
}

/** 终端 Claude Code 的 MCP 配置：一个 http 服务指回 Friday，按 jobId 绑任务。 */
export function buildMcpConfig(id: string, port: number): string {
  return JSON.stringify({ mcpServers: { friday: { type: "http", url: `http://127.0.0.1:${port}/mcp/${id}` } } }, null, 2);
}

export function writeHookFiles(id: string, autonomous = false, readOnly = false): ClaudeFiles {
  mkdirSync(runsDir(), { recursive: true });
  const hook = join(runsDir(), `${id}.hook.sh`);
  writeFileSync(hook, buildHookScript(id, config.port));
  chmodSync(hook, 0o755);
  let guard: string | undefined;
  if (autonomous || readOnly) {
    guard = join(runsDir(), `${id}.guard.sh`);
    // 只读查询不该推送，拦下就完了；自主任务拦下后挂一条推送待审
    writeFileSync(guard, buildGuardScript(process.execPath, readOnly ? undefined : `http://127.0.0.1:${config.port}/jobs/${id}/push-request`));
    chmodSync(guard, 0o755);
  }
  const settings = join(runsDir(), `${id}.settings.json`);
  writeFileSync(settings, buildHookSettings(hook, guard, readOnly));
  const mcp = join(runsDir(), `${id}.mcp.json`);
  writeFileSync(mcp, buildMcpConfig(id, config.port));
  return { settings, mcp };
}

/** 每次拉起 claude 都带：跳过权限（Friday 只透传用户指令）、hook、指回 Friday 的 MCP、怎么汇报的系统提示。 */
export function claudeArgs(files: ClaudeFiles, headless = false, project?: string): string[] {
  return [
    ...(headless ? ["-p", "--model", HEADLESS_MODEL] : []),
    "--dangerously-skip-permissions",
    "--settings",
    files.settings,
    "--mcp-config",
    files.mcp,
    "--append-system-prompt",
    terminalBridgePrompt(headless ? undefined : project),
  ];
}

/** 选项本身不带引号，只有取值要 quote——脚本里那条命令的形状得跟以前一样 */
export function claudeFlags(files: ClaudeFiles, headless = false, project?: string): string {
  return claudeArgs(files, headless, project)
    .map((a) => (a.startsWith("-") ? a : shellQuote(a)))
    .join(" ");
}

export interface SessionLaunch {
  id: string;
  repoDir: string;
  task?: string;
  kind: TermSessionKind;
  project?: string;
  baseBranch?: string;
  resumeSessionId?: string;
  title?: string;
  description?: string;
  existingBranch?: string;
}

export const worktreeFile = (id: string) => join(runsDir(), `${id}.worktree`);

export function prepPrompt(id: string, repoDir: string, base?: string, info?: { title?: string; description?: string }, existingBranch?: string): string {
  const repo = repoDir.replace(/\/+$/, "").split("/").pop() ?? "repo";
  const about = info?.title ? untrusted("task", [info.title, info.description].filter(Boolean).join("\n")) : undefined;
  const branchSteps = existingBranch
    ? [
        `0. 这条任务已经在分支 ${existingBranch} 上做过，不要新建分支：为它建 worktree（git worktree add <路径> ${existingBranch}）。先用 git worktree list 看它检出在哪：检出在另一个不是主仓（${repoDir}）的 worktree 里，就直接复用那个 worktree；检出在主仓里时，不许在主仓执行 git switch / git checkout 把它切走（那是用户正在用的主仓），这时 git worktree add 会失败——直接输出「分支正被主仓检出，无法另建 worktree」，不写路径文件，以非零退出。`,
        "1. 先查这个项目自己的规则：CLAUDE.md、项目 skill、CONTRIBUTING 和现有 worktree 的惯例。项目有规则就照项目的来。",
        `2. 项目没有规则时：worktree 建在主仓的兄弟目录 ../${repo}-<分支简称>（分支名里的 / 换成 -）。`,
        `3. 先 git fetch；本地没有 ${existingBranch} 就从 origin/${existingBranch} 检出。`,
      ]
    : [
        "0. 必须新建分支和新 worktree，不许复用已有的 worktree 或分支：git worktree list 里的那些属于别的任务，只拿来参考命名惯例。",
        "1. 先查这个项目自己的规则：CLAUDE.md、项目 skill、CONTRIBUTING 和现有分支的惯例。项目有规则就照项目的来。",
        `2. 项目没有规则时：分支名按「${BRANCH_RULE}」；worktree 建在主仓的兄弟目录 ../${repo}-<分支简称>（分支名里的 / 换成 -）。`,
        base ? `3. 基线是分支 ${base}：先 git fetch，再从它检出新分支。` : "3. 基线是默认分支：先 git fetch，再从 origin 的默认分支检出新分支。",
      ];
  return [
    `你在 ${repoDir} 这个仓库的主目录里，只做一件事：为接下来的任务准备好分支和 git worktree，然后退出。不要改任何业务代码，不要 push。`,
    ...(about ? [`这次的任务是：\n${about}`, UNTRUSTED_NOTE, ...(existingBranch ? [] : ["分支名要能看出是这件事。"])] : []),
    ...branchSteps,
    "4. 按项目的方式把依赖装好，让新 worktree 能直接跑起来（前端仓库可以先用 cp -c 从主仓克隆 node_modules，再跑一次 install 补差）。",
    "5. 分支名和 worktree 目录名里都不要出现 friday。",
    `6. 最后把 worktree 的绝对路径（只有路径，一行）写进 ${worktreeFile(id)}，然后结束。不许写主仓本身或主仓工作区里的普通目录（不是 git worktree 的目录）——主仓是 ${repoDir}，写进去就等于在用户的主仓里直接干活，Friday 会拒收。`,
    existingBranch ? "不要提问——没人会回答；拿不准就自己定，但不要另起分支。" : "不要提问——没人会回答；拿不准就自己定，但绝不复用已有的 worktree 或分支，宁可多建一个。",
  ].join("\n");
}

export function workCommand(req: SessionLaunch, claudePath: string, port: number, files: ClaudeFiles): string[] {
  const flags = claudeFlags(files, req.kind !== "interactive", req.project);
  const prompt = req.task ? ` ${shellQuote(req.task)}` : "";
  const claude = req.resumeSessionId
    ? `${shellQuote(claudePath)} ${flags} --resume ${shellQuote(req.resumeSessionId)}${prompt} || ${shellQuote(claudePath)} ${flags}${prompt}`
    : `${shellQuote(claudePath)} ${flags}${prompt}`;
  // 不再用 script 录终端：macOS 的 script 不把窗口尺寸变化转给它开的 pty，Claude 一直按启动时的宽度画（2026-09-30 用户报：
  // 窗口放大了内容还只有那么宽，实测窗格 184×43、script 里 Claude 的 pty 85×25）。改由 tmux pipe-pane 把窗格输出追加进同一个日志
  const tmux = shellQuote(tmuxPath() ?? "tmux");
  return [
    `${tmux} pipe-pane -t "$TMUX_PANE" ${shellQuote(`cat >> ${shellQuote(jobLog(req.id))}`)}`,
    `/bin/zsh -c ${shellQuote(claude)}`,
    "code=$?",
    `${tmux} pipe-pane -t "$TMUX_PANE"`,
    `curl -s -m 3 -X POST ${shellQuote(`http://127.0.0.1:${port}/jobs/${req.id}/exit`)} -H 'content-type: application/json' -d "{\\"code\\":$code}" >/dev/null 2>&1`,
  ];
}

export function buildSessionScript(req: SessionLaunch, claudePath: string, port: number, files: ClaudeFiles, prepSettings?: string): string {
  const api = (p: string) => shellQuote(`http://127.0.0.1:${port}/jobs/${req.id}/${p}`);
  const wt = shellQuote(worktreeFile(req.id));
  const prepare =
    req.kind === "query"
      ? []
      : [
          `rm -f ${wt}`,
          `${shellQuote(claudePath)} -p --model sonnet --dangerously-skip-permissions --settings ${shellQuote(prepSettings ?? "")} ${shellQuote(prepPrompt(req.id, req.repoDir, req.baseBranch, { title: req.title, description: req.description }, req.existingBranch))}`,
          `if [ ! -s ${wt} ]; then`,
          `  curl -s -m 3 -X POST ${api("exit")} -H 'content-type: application/json' -d '{"code":2,"phase":"prepare"}' >/dev/null 2>&1`,
          "  exec /bin/zsh -il",
          "fi",
          `cd "$(cat ${wt})" || exit 1`,
          `if [ "$PWD" -ef ${shellQuote(req.repoDir)} ]; then`,
          `  curl -s -m 3 -X POST ${api("exit")} -H 'content-type: application/json' -d '{"code":2,"phase":"prepare"}' >/dev/null 2>&1`,
          "  exec /bin/zsh -il",
          "fi",
          `wcode=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST ${api("worktree")} -H 'content-type: application/json' -d "{\\"path\\":\\"$PWD\\"}" 2>/dev/null)`,
          `[ "$wcode" = 409 ] && exec /bin/zsh -il`,
        ];
  return [
    "#!/bin/zsh",
    `cd ${shellQuote(req.repoDir)} || exit 1`,
    UNSET_CLAUDE_ENV,
    ...prepare,
    `printf '\\033]0;%s\\007' "$(basename "$PWD")"`,
    ...workCommand(req, claudePath, port, files),
    "exec /bin/zsh -il",
    "",
  ].join("\n");
}

export function writePrepSettings(id: string): string {
  mkdirSync(runsDir(), { recursive: true });
  const guard = join(runsDir(), `${id}.prep.guard.sh`);
  writeFileSync(guard, buildGuardScript());
  chmodSync(guard, 0o755);
  const settings = join(runsDir(), `${id}.prep.settings.json`);
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: shellQuote(guard), timeout: 10 }] }] } }, null, 2));
  return settings;
}

let claudeFinder: () => Promise<string> = findClaude;
export function setClaudeFinder(fn: () => Promise<string>): void {
  claudeFinder = fn;
}

export async function launchInSession(req: SessionLaunch, tmuxName: string): Promise<void> {
  const claudePath = await claudeFinder();
  const files = writeHookFiles(req.id, req.kind === "autonomous", req.kind === "query");
  const prep = req.kind === "query" ? undefined : writePrepSettings(req.id);
  const script = join(runsDir(), `${req.id}.sh`);
  writeFileSync(script, buildSessionScript(req, claudePath, config.port, files, prep));
  chmodSync(script, 0o755);
  await newSession(tmuxName, req.repoDir, script);
}

export async function writeResumeScript(req: SessionLaunch, cwd: string, hooks: TermSessionKind = req.kind, keepShell = false): Promise<string> {
  const claudePath = await claudeFinder();
  const files = writeHookFiles(req.id, hooks === "autonomous", hooks === "query");
  const script = join(runsDir(), `${req.id}.resume.sh`);
  writeFileSync(script, ["#!/bin/zsh", `cd ${shellQuote(cwd)} || exit 1`, UNSET_CLAUDE_ENV, ...workCommand(req, claudePath, config.port, files), ...(keepShell ? ["exec /bin/zsh -il"] : []), ""].join("\n"));
  chmodSync(script, 0o755);
  return script;
}
