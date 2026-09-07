import { describe, expect, it } from "vitest";
import { buildHookScript, buildHookSettings, buildScript } from "./runner.js";

describe("Claude 启动脚本", () => {
  it("用 script 录日志、绝对路径调 claude 并跳过权限、注入 hook 设置、退出时回报退出码、结束后留交互 shell", () => {
    const script = buildScript({ id: "job1", dir: "/Users/me/my proj", task: `修 it's bug`, terminal: "ghostty" }, "/opt/bin/claude", 7788, "/data/runs/job1.settings.json");
    expect(script).toContain(`cd '/Users/me/my proj' || exit 1`);
    expect(script).toMatch(/script -q '.*job1\.log' \/bin\/zsh -c '/);
    expect(script).toContain("/opt/bin/claude");
    expect(script).toContain("--dangerously-skip-permissions --settings");
    expect(script).toContain("job1.settings.json");
    expect(script).toContain("修 it");
    expect(script).toMatch(/mkdir '.*job1\.log\.lock' 2>\/dev\/null \|\| exit 0/);
    expect(script).toContain("/jobs/job1/exit");
    expect(script).toContain("stty sane");
    expect(script.trim().endsWith("exec /bin/zsh -il")).toBe(true);
  });

  it("hook 设置指向 Stop 事件的命令", () => {
    const json = JSON.parse(buildHookSettings("/data/runs/job1.hook.sh")) as { hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> } };
    expect(json.hooks.Stop[0]!.hooks[0]).toMatchObject({ type: "command", command: "'/data/runs/job1.hook.sh'" });
  });
});

describe("Stop hook 脚本", () => {
  it("用 sidecar 自己的 node 绝对路径，错误写入 hook.log", () => {
    const script = buildHookScript("job1", 7788, "/opt/node/bin/node");
    expect(script).toContain("'/opt/node/bin/node' -e");
    expect(script).toMatch(/exec >>'.*job1\.hook\.log' 2>&1/);
    expect(script).toContain("/jobs/job1/message");
    expect(script).toContain("last_assistant_message");
  });
});
