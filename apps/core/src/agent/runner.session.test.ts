import { describe, expect, it } from "vitest";
import { buildSessionScript, prepPrompt, workCommand, worktreeFile } from "./runner.js";
import { FORBIDDEN } from "./guard.js";

const files = { settings: "/d/runs/j.settings.json", mcp: "/d/runs/j.mcp.json" };
const prep = "/d/runs/j.prep.settings.json";

describe("两段式启动脚本", () => {
  it("交互式：先在主仓跑准备段，拿到 worktree 再 cd 进去起干活的 Claude，最后留 shell", () => {
    const s = buildSessionScript({ id: "j", repoDir: "/r/app", task: "改个按钮", kind: "interactive", project: "app" }, "/bin/claude", 7788, files, prep);
    const lines = s.split("\n");
    expect(lines).toContain("cd '/r/app' || exit 1");
    const rmAt = lines.findIndex((l) => l.startsWith(`rm -f '${worktreeFile("j")}'`));
    const prepAt = lines.findIndex((l) => l.includes("--model sonnet") && l.includes(prep));
    const cdAt = lines.findIndex((l) => l.startsWith(`cd "$(cat '${worktreeFile("j")}')"`));
    const workAt = lines.findIndex((l) => l.startsWith("script -q"));
    expect(rmAt).toBeGreaterThan(0);
    expect(prepAt).toBeGreaterThan(rmAt);
    expect(cdAt).toBeGreaterThan(prepAt);
    expect(workAt).toBeGreaterThan(cdAt);
    expect(s).toContain('"code":2,"phase":"prepare"');
    expect(s).toContain("/jobs/j/worktree");
    expect(lines.at(-2)).toBe("exec /bin/zsh -il");
    expect(lines[workAt]).not.toContain("-p --model");
  });

  it("后台查询不建 worktree：没有准备段，直接在主仓只读跑 -p", () => {
    const s = buildSessionScript({ id: "j", repoDir: "/r/app", task: "查一下", kind: "query" }, "/bin/claude", 7788, files);
    expect(s).not.toContain("--model sonnet");
    expect(s).not.toContain(".worktree");
    expect(s).toMatch(/-p --model.*opus/);
  });

  it("自主任务：准备段之后干活段用 -p --model opus", () => {
    const s = buildSessionScript({ id: "j", repoDir: "/r/app", task: "修 bug", kind: "autonomous", project: "app" }, "/bin/claude", 7788, files, prep);
    expect(s).toContain("--model sonnet");
    expect(s).toMatch(/script -q .*-p --model.*opus/);
  });

  it("接回：带 --resume，接不上就新开；追加写日志；带上要说的话", () => {
    const [cmd] = workCommand({ id: "j", repoDir: "/r/app", kind: "interactive", resumeSessionId: "sess-1", task: "顺带改一下" }, "/bin/claude", 7788, files);
    expect(cmd).toContain("script -q -a");
    expect(cmd).toContain("--resume");
    expect(cmd).toContain("sess-1");
    expect(cmd!.split("||").length).toBe(2);
    expect(cmd).toContain("顺带改一下");
  });

  it("准备段提示词：先看项目规则、兄弟目录、基线、不带 friday、写路径文件", () => {
    const p = prepPrompt("j", "/r/app", "feat/base");
    expect(p).toContain("CLAUDE.md");
    expect(p).toContain("../app-<分支简称>");
    expect(p).toContain("feat/base");
    expect(p).toContain(worktreeFile("j"));
    expect(p).toMatch(/不要出现 friday/);
  });

  it("准备段要用的 git 命令不被守卫拦，push 照样拦", () => {
    const blocked = (cmd: string) => FORBIDDEN.some(([p]) => new RegExp(p).test(cmd));
    expect(blocked("git fetch origin")).toBe(false);
    expect(blocked("git worktree add ../app-feat-x -b feat/x origin/main")).toBe(false);
    expect(blocked("git push origin feat/x")).toBe(true);
  });
});
