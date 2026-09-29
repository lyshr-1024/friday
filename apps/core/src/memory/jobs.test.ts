import { describe, expect, it } from "vitest";
import { createJob, fridaySessionIds, recordTerminalInput, setJobSession, terminalInputTexts } from "./jobs.js";
import { createTask } from "./tasks.js";

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
