import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "./index.js";
import { createTask, getTask } from "../memory/tasks.js";
import { listAudit } from "../memory/audit.js";

vi.mock("../connectors/keychain.js", () => ({ keychainGet: async () => undefined }));

const post = (id: string, url: string) => app.request(`/tasks/${id}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });

afterEach(() => vi.unstubAllGlobals());

describe("资料链接接口", () => {
  it("贴链接：立刻返回，标题随后补上；去重；能删", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html><head><title>Export Center</title></head></html>"));
    const t = createTask({ title: "资料", kind: "verbal", source: {} });
    const res = await post(t.id, "https://example.com/a/b?utm_source=x");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { source: { docs: unknown[] } }).source.docs).toEqual([{ url: "https://example.com/a/b?utm_source=x", from: "user" }]);
    await vi.waitFor(() => expect(getTask(t.id)!.source.docs![0]!.title).toBe("Export Center"));
    await post(t.id, "https://example.com/a/b/");
    expect(getTask(t.id)!.source.docs).toHaveLength(1);
    expect(listAudit({ taskId: t.id, limit: 10 }).some((e) => e.action === "doc_added")).toBe(true);

    const del = await app.request(`/tasks/${t.id}/docs?url=${encodeURIComponent("https://example.com/a/b")}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(getTask(t.id)!.source.docs).toEqual([]);
  });

  it("取不到标题也不报错，条目照留", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    const t = createTask({ title: "断网", kind: "verbal", source: {} });
    expect((await post(t.id, "https://nope.invalid/x")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(getTask(t.id)!.source.docs).toEqual([{ url: "https://nope.invalid/x", from: "user" }]);
  });

  it("不是 http 链接就拒绝", async () => {
    const t = createTask({ title: "坏链接", kind: "verbal", source: {} });
    expect((await post(t.id, "javascript:alert(1)")).status).toBe(400);
    expect((await post(t.id, "not a url")).status).toBe(400);
  });

  it("删掉的链接记墓碑，再贴一次就清掉", async () => {
    vi.stubGlobal("fetch", async () => new Response("<title>x</title>"));
    const t = createTask({ title: "墓碑", kind: "verbal", source: { docs: [{ url: "https://m.example/req", from: "meegle" }] } });
    await app.request(`/tasks/${t.id}/docs?url=${encodeURIComponent("https://m.example/req/")}`, { method: "DELETE" });
    expect(getTask(t.id)!.source.removedDocs).toEqual(["https://m.example/req"]);
    await post(t.id, "https://m.example/req");
    expect(getTask(t.id)!.source.removedDocs).toEqual([]);
    expect(getTask(t.id)!.source.docs).toEqual([{ url: "https://m.example/req", from: "user" }]);
  });
});
