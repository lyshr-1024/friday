import { beforeEach, describe, expect, it } from "vitest";
import { hasSession, killWindow, listSessionNames, listWindows, newSession, safeName, sendText, sessionName, setTmuxRunner, tmuxArgs, TMUX_CONF } from "./tmux.js";

let calls: string[][] = [];
let reply: (args: string[]) => string | Error = () => "";
beforeEach(() => {
  calls = [];
  reply = () => "";
  setTmuxRunner(async (args) => {
    calls.push(args);
    const r = reply(args);
    if (r instanceof Error) throw r;
    return r;
  });
});
const tail = (c: string[]) => c.slice(4);

describe("tmux 封装", () => {
  it("一律走 friday socket 和 Friday 自己的配置文件", () => {
    const a = tmuxArgs("ls");
    expect(a.slice(0, 3)).toEqual(["-L", "friday", "-f"]);
    expect(a[3]).toMatch(/tmux\.conf$/);
    expect(a.slice(4)).toEqual(["ls"]);
  });

  it("配置禁掉前缀、关状态栏、开鼠标、剪贴板走 OSC 52", () => {
    for (const line of ["set -g prefix None", "set -g status off", "set -g mouse on", "set -g set-clipboard on"]) expect(TMUX_CONF).toContain(line);
  });

  it("会话名取仓库目录名，非法字符换成 -", () => {
    expect(sessionName("/Users/me/workspace/fe-wealth-admin/", "3f2a9c1b")).toBe("fe-wealth-admin-3f2a9c1b");
    expect(safeName("repo-feat/a.b:c")).toBe("repo-feat-a-b-c");
  });

  it("建会话：detached、工作目录、zsh 跑脚本", async () => {
    await newSession("repo-1", "/x/repo", "/data/runs/j.sh");
    expect(tail(calls[0]!)).toEqual(["new-session", "-d", "-s", "repo-1", "-c", "/x/repo", "-x", "200", "-y", "50", "/bin/zsh", "/data/runs/j.sh"]);
  });

  it("说话：文本按字面发到精确匹配的会话，再单独发一个回车", async () => {
    await sendText("repo-1", "改一下 $HOME; rm -rf");
    expect(calls.map(tail)).toEqual([
      ["send-keys", "-t", "=repo-1:", "-l", "改一下 $HOME; rm -rf"],
      ["send-keys", "-t", "=repo-1:", "Enter"],
    ]);
  });

  it("has-session 报错就是不在", async () => {
    reply = () => new Error("can't find session: nope");
    expect(await hasSession("nope")).toBe(false);
    reply = () => "";
    expect(await hasSession("repo-1")).toBe(true);
    expect(tail(calls.at(-1)!)).toEqual(["has-session", "-t", "=repo-1"]);
  });

  it("没有 server 时会话列表为空；别的错误返回 undefined，调用方不许据此收尸", async () => {
    reply = () => Object.assign(new Error("exit 1"), { stderr: "no server running on /private/tmp/tmux-501/friday" });
    expect(await listSessionNames()).toEqual([]);
    reply = () => Object.assign(new Error("exit 1"), { stderr: "error connecting to /private/tmp/tmux-501/friday (No such file or directory)" });
    expect(await listSessionNames()).toEqual([]);
    reply = () => Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    expect(await listSessionNames()).toBeUndefined();
    reply = () => "a\nb\n";
    expect(await listSessionNames()).toEqual(["a", "b"]);
  });

  it("窗口列表解析；只剩一个窗口时不关", async () => {
    reply = (a) => (a.includes("list-windows") ? "0|claude|1\n1|zsh|0\n" : "");
    expect(await listWindows("repo-1")).toEqual([{ index: 0, name: "claude", active: true }, { index: 1, name: "zsh", active: false }]);
    expect(await killWindow("repo-1", 1)).toBe(true);
    expect(tail(calls.at(-1)!)).toEqual(["kill-window", "-t", "=repo-1:1"]);
    reply = (a) => (a.includes("list-windows") ? "0|claude|1\n" : "");
    calls = [];
    expect(await killWindow("repo-1", 0)).toBe(false);
    expect(calls.some((c) => c.includes("kill-window"))).toBe(false);
  });
});
