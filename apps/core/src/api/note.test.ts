import type { Todo } from "@friday/shared";
import { describe, expect, it } from "vitest";
import { app } from "./index.js";

const post = (payload: unknown) =>
  app.request("/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

describe("POST /note", () => {
  it("写入本地待办并返回", async () => {
    const res = await post({ text: "给 Meegle 连接器写测试", due: "2026-09-05" });
    expect(res.status).toBe(201);
    const todo = (await res.json()) as Todo;
    expect(todo).toMatchObject({ text: "给 Meegle 连接器写测试", source: "local", due: "2026-09-05", done: false });
    const list = (await (await app.request("/todos")).json()) as Todo[];
    expect(list.some((t) => t.id === todo.id)).toBe(true);
  });

  it("拒绝空文本和错误日期", async () => {
    expect((await post({ text: "" })).status).toBe(400);
    expect((await post({ text: "x", due: "明天" })).status).toBe(400);
  });
});
