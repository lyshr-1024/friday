import { describe, expect, it } from "vitest";
import { createJob, fridaySessionIds, getJob, reapStaleJobs, recordTerminalInput, setGhosttyId, setJobSession, terminalInputTexts } from "./jobs.js";
import { createTask } from "./tasks.js";

const mk = (id: string, ghostty?: string) => {
  createJob({ id, project: "p", dir: "/tmp", logPath: "/tmp/x.log" });
  if (ghostty) setGhosttyId(id, ghostty);
};

describe("启动收尸：外部窗口不跟着 sidecar 死", () => {
  it("窗口还在的留着，没了的才收", async () => {
    mk("alive-1", "G-ALIVE");
    mk("dead-1", "G-DEAD");
    mk("no-id");
    const reaped = await reapStaleJobs(async (id) => id === "G-ALIVE");
    expect(reaped.sort()).toEqual(["dead-1", "no-id"]);
    expect(getJob("alive-1")?.status).toBe("running");
    expect(getJob("dead-1")?.status).toBe("done");
    // 没记下 terminal id 的问不了，只能当它死了
    expect(getJob("no-id")?.status).toBe("done");
  });

  it("问不到就留着：重装 .app 之后自动化权限被重置，osascript 会失败", async () => {
    mk("unknown-1", "G-UNKNOWN");
    // undefined = 问不到，不是「不在」。误收的代价是用户手上开着的终端全断了关联
    expect(await reapStaleJobs(async () => undefined)).toEqual([]);
    expect(getJob("unknown-1")?.status).toBe("running");
  });

  it("不给判定函数就全收（Terminal.app 那条路没有 id 可问）", async () => {
    mk("legacy", "G-ALIVE");
    // 上一个 case 留下的 alive-1 还开着，这次不给判定函数，两条一起收
    expect((await reapStaleJobs()).sort()).toEqual(["alive-1", "legacy", "unknown-1"]);
    expect(getJob("legacy")?.status).toBe("done");
    expect(getJob("alive-1")?.status).toBe("done");
  });
});

describe("Friday 注入终端的文本与自己拉起的会话", () => {
  it("say 过的文本能整体取出来，trim 过", () => {
    createJob({ id: "j-in", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    recordTerminalInput("j-in", "  顺带再改一条同需求下的缺陷：\n标题 ");
    expect(terminalInputTexts().has("顺带再改一条同需求下的缺陷：\n标题")).toBe(true);
  });

  it("只有自主 / 后台任务的 session 算 Friday 的；交互式终端里是用户在说话", () => {
    const a = createTask({ title: "a", kind: "code", source: { autonomous: true }, status: "processing" });
    const b = createTask({ title: "b", kind: "code", source: {}, status: "processing" });
    const q = createTask({ title: "q", kind: "slack", source: { headless: true }, status: "processing" });
    createJob({ id: "j-auto", project: "demo", dir: "/tmp", logPath: "/tmp/x.log", taskId: a.id });
    createJob({ id: "j-me", project: "demo", dir: "/tmp", logPath: "/tmp/x.log", taskId: b.id });
    createJob({ id: "j-q", project: "demo", dir: "/tmp", logPath: "/tmp/x.log", taskId: q.id });
    setJobSession("j-auto", "sess-auto");
    setJobSession("j-me", "sess-me");
    setJobSession("j-q", "sess-q");
    const ids = fridaySessionIds();
    expect(ids.has("sess-auto")).toBe(true);
    expect(ids.has("sess-q")).toBe(true);
    expect(ids.has("sess-me")).toBe(false);
  });
});
