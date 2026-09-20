import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Ghostty 的 AppleScript 接口：开窗口、往里说话、聚焦、关掉。
 *
 * 之前内嵌 PTY 能直接往文件描述符写字节，换成外部窗口就没有那个句柄了。Ghostty 自带
 * `input text` / `send key`，走的是 app 自己的脚本接口而不是模拟键盘，所以只要「自动化」
 * 权限，不需要「辅助功能」。
 *
 * 认窗口一律用 terminal id（开窗口时拿到手，存进 jobs 表），不要用标题——终端里的
 * Claude Code 自己会改标题。
 */

/** AppleScript 字符串字面量：反斜杠和双引号要转义。 */
function osaString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function osa(script: string): Promise<string> {
  // 测试里不要真去操作用户开着的 Ghostty（同 lessons.ts 里那条）
  if (process.env.VITEST) return "test-terminal-id";
  const { stdout } = await execFileP("/usr/bin/osascript", ["-e", script], { timeout: 10_000 });
  return stdout.trim();
}

const termRef = (id: string) => `first terminal whose id is ${osaString(id)}`;

/**
 * 开一个窗口跑脚本，返回它的 terminal id；拿不到 id 不算失败，窗口照样开着，
 * 只是这条 job 之后没法 say / focus。
 *
 * 不设 `wait after command`：脚本跑完窗口就关掉，「关终端」才关得干净（脚本末尾也不再
 * 留交互 shell）。代价是脚本中途挂掉时窗口会连同报错一起消失，要排查看 <id>.log。
 */
export async function openWindow(script: string, dir: string): Promise<string | undefined> {
  const out = await osa(
    [
      `tell application "Ghostty"`,
      `  activate`,
      `  set cfg to new surface configuration`,
      `  set initial working directory of cfg to ${osaString(dir)}`,
      // command 会按 shell 规则拆词，脚本路径里有「Application Support」这种空格，
      // 不加引号会被拆成两段，窗口开出来但脚本没跑、随即关闭
      `  set command of cfg to ${osaString(`'${script.replace(/'/g, `'\\''`)}'`)}`,
      `  set w to new window with configuration cfg`,
      `  return id of (first terminal of first tab of w)`,
      `end tell`,
    ].join("\n"),
  ).catch(() => "");
  return out || undefined;
}

/**
 * 输入一句话并回车。文本和回车分两次发，中间隔一下：连着发 Claude Code 会把整串当成
 * 粘贴，尾随的回车变成换行留在输入框里不提交（内嵌那版踩过，换 AppleScript 后照样成立）。
 */
const ENTER_DELAY_MS = 200;

export async function inputText(terminalId: string, text: string): Promise<boolean> {
  try {
    await osa(`tell application "Ghostty" to input text ${osaString(text)} to (${termRef(terminalId)})`);
    await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
    await osa(`tell application "Ghostty" to send key "enter" to (${termRef(terminalId)})`);
    return true;
  } catch {
    return false;
  }
}

/** 把这个终端的窗口拉到前台。 */
export async function focusTerminalById(terminalId: string): Promise<boolean> {
  // 先确认它还在：窗口关掉之后 activate 照样会把 Ghostty 拉到前台，
  // 用户看到的是「点了打开终端，跳进了另一个不相干的窗口」。
  if (!(await isAlive(terminalId))) return false;
  try {
    await osa(`tell application "Ghostty"\n  activate\n  focus (${termRef(terminalId)})\nend tell`);
    return true;
  } catch {
    return false;
  }
}

/** 关掉这个终端，里面跑着的 Claude Code 跟着结束。 */
export async function closeTerminalById(terminalId: string): Promise<boolean> {
  try {
    await osa(`tell application "Ghostty" to close (${termRef(terminalId)})`);
    return true;
  } catch {
    return false;
  }
}

/** 这个终端还在不在。窗口被手动关掉之后 say / focus 都没意义了。 */
export async function isAlive(terminalId: string): Promise<boolean> {
  const out = await osa(
    `tell application "Ghostty" to return (count of (every terminal whose id is ${osaString(terminalId)})) as text`,
  ).catch(() => "0");
  return out !== "0";
}
