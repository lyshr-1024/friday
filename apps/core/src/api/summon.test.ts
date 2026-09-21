import { describe, expect, it, vi, beforeAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// 以前靠「没文字就不调模型」侥幸没打到真实 API，现在模型永远跑，必须显式拦住
vi.mock("../agent/summon/card.js", () => ({
  summonCard: vi.fn().mockResolvedValue({ verdict: "", actions: [] }),
  SUMMON_MODEL: "claude-sonnet-5",
}));

const { app } = await import("./index.js");
const { addPending, createTask, getTask } = await import("../memory/tasks.js");
const { pageHint } = await import("./summon.js");
const { config } = await import("../config.js");

const snapshot = {
  at: Date.now(),
  app: { bundleId: "com.apple.finder", name: "Finder", title: "下载" },
  permissions: { accessibility: false, automation: false, screen: false },
};

describe("POST /summon", () => {
  it("返回 SSE，首帧是 rules", async () => {
    const res = await app.request("/summon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('"type":"rules"');
    expect(body).toContain('"type":"done"');
  });

  it("缺 snapshot 返回 400", async () => {
    const res = await app.request("/summon", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });
});

describe("POST /summon/act", () => {
  it("create_task 建出任务并返回 id", async () => {
    const res = await app.request("/summon/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: { kind: "create_task", label: "建成任务", title: "呼出模式冒烟" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; taskId?: string };
    expect(body.ok).toBe(true);
    expect(body.taskId).toBeTruthy();
  });

  it("mark_done 对挂着 pending 动作的任务收工：状态变 done 且 pending 清空", async () => {
    const task = createTask({ title: "呼出模式标完成", kind: "verbal", source: {} });
    addPending(task.id, { type: "slack_reply", label: "回复拂晓", detail: "草稿", payload: { text: "好的" } });

    const res = await app.request("/summon/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: { kind: "mark_done", label: "标记完成", taskId: task.id } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const after = getTask(task.id);
    expect(after?.status).toBe("done");
    expect(after?.pending ?? []).toEqual([]);
  });

  it("不认识的动作返回 400", async () => {
    const res = await app.request("/summon/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: { kind: "launch_missile", label: "x" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("pageHint", () => {
  beforeAll(() => {
    writeFileSync(
      join(config.dataDir, "projects.md"),
      "## whale-console\n- 目录：/w\n- 环境：测试 console.longbridge.xyz/x/\n\n## fe-wealth-admin\n- 目录：/f\n- 环境：线上 console.longbridge.xyz/\n",
    );
  });

  it("说清是哪个环境、哪个页面、项目在哪，但不替终端推断文件", () => {
    const hint = pageHint("https://console.longbridge.xyz/x/wbo/funds/params?tab=1", "/Users/me/work/whale-console");
    expect(hint).toBe("我开着的是 whale-console 的测试环境。页面路径 /x/wbo/funds/params，项目在 /Users/me/work/whale-console，先按路由约定找到对应文件再动手。");
  });

  it("地址谁都对不上时只说页面路径", () => {
    expect(pageHint("https://example.com/a/b", "/d")).toBe("页面路径 /a/b，项目在 /d，先按路由约定找到对应文件再动手。");
  });

  it("没有网址就什么都不加", () => {
    expect(pageHint(undefined, "/d")).toBe("");
  });
});
