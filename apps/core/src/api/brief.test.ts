import { describe, expect, it, vi } from "vitest";
import { brief } from "./brief.js";

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
