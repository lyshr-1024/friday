import { beforeEach, describe, expect, it } from "vitest";
import { postNotices } from "../agent/notices.js";
import { db } from "../memory/db.js";
import { setCursor } from "../memory/inbox.js";
import { createTask, updateTask } from "../memory/tasks.js";
import { app } from "./index.js";

const post = (body: unknown) => app.request("/main/presence", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  db().exec("DELETE FROM tasks; DELETE FROM sync_state WHERE source LIKE 'notice:%' OR source = 'main:away'");
});

describe("POST /main/presence", () => {
  it("body 不合法回 400", async () => {
    expect((await post({ active: "yes" })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("离开 20 分钟、期间来了 notice：回 200 带 notice 汇总", async () => {
    postNotices();
    setCursor("main:away", String(Date.now() - 20 * 60_000));
    const b = createTask({ title: "卡住的", kind: "code", status: "blocked", source: {} });
    updateTask(b.id, { progress: "没权限" });
    postNotices();
    const res = await post({ active: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { digest: { kind: string; content: string } };
    expect(body.digest.kind).toBe("notice");
    expect(body.digest.content).toContain("卡住的");
  });

  it("没离开过：200 但没有汇总", async () => {
    const res = await post({ active: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { digest?: unknown }).digest).toBeUndefined();
  });
});
