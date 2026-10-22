import { describe, expect, it, vi } from "vitest";
import { brief } from "./brief.js";
import { createTask, updateTask } from "../memory/tasks.js";

vi.mock("../agent/briefJob.js", async (orig) => ({
  ...(await orig<typeof import("../agent/briefJob.js")>()),
  startBriefJob: vi.fn(async (id: string) => {
    if (id === "boom") throw new Error("内嵌终端需要 tmux：brew install tmux");
    if (id === "busy") return { error: "这条需求的理解卡正在建", status: 409 };
    if (id === "no") return { error: "缺陷不建理解卡", status: 404 };
    return { jobId: "j1" };
  }),
}));

const post = (id: string) => brief.request(`/tasks/${id}/brief`, { method: "POST" });

describe("POST /tasks/:id/brief", () => {
  it("可建 200，已在建 409，不能建 404，抛错 500 带原文", async () => {
    const ok = await post("ok");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ jobId: "j1" });
    expect((await post("busy")).status).toBe(409);
    const no = await post("no");
    expect(no.status).toBe(404);
    expect(await no.json()).toEqual({ error: "缺陷不建理解卡" });
    const boom = await post("boom");
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "内嵌终端需要 tmux：brew install tmux" });
  });
});

describe("PATCH /tasks/:id/brief、POST /tasks/:id/brief/deps/:index/ready", () => {
  const withBrief = () => {
    const t = createTask({ title: "加排序", kind: "verbal", project: "p-api", status: "understood", source: {} });
    updateTask(t.id, {
      source: {
        brief: { todo: "加排序", deps: [{ what: "接口", status: "pending" }], acceptance: { source: "own", cases: ["降序"] }, release: "", plan: "", size: "small", sizeWhy: "小", review: "approved", basis: "b", at: "2026-10-01T00:00:00.000Z", features: [] },
      },
    });
    return t;
  };
  const json = (body: unknown) => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("改档：size 不对 400，没有理解卡 404，成功回任务", async () => {
    const t = withBrief();
    expect((await brief.request(`/tasks/${t.id}/brief`, json({ size: "huge" }))).status).toBe(400);
    const bare = createTask({ title: "没卡", kind: "verbal", project: "p-api", status: "understood", source: {} });
    expect((await brief.request(`/tasks/${bare.id}/brief`, json({ size: "large" }))).status).toBe(404);
    const ok = await brief.request(`/tasks/${t.id}/brief`, json({ size: "large" }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { source: { brief: { size: string } } }).source.brief.size).toBe("large");
  });

  it("标依赖到了：下标不对 404，非数字 400，成功回任务", async () => {
    const t = withBrief();
    expect((await brief.request(`/tasks/${t.id}/brief/deps/x/ready`, { method: "POST" })).status).toBe(400);
    expect((await brief.request(`/tasks/${t.id}/brief/deps/3/ready`, { method: "POST" })).status).toBe(404);
    const ok = await brief.request(`/tasks/${t.id}/brief/deps/0/ready`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { source: { brief: { deps: Array<{ status: string }> } } }).source.brief.deps[0]!.status).toBe("ready");
  });
});
