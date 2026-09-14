import type { Task, TaskBoard } from "@friday/shared";
import { describe, expect, it } from "vitest";
import { app } from "./index.js";

const post = (payload: unknown) =>
  app.request("/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

describe("POST /note", () => {
  it("建成一条待办任务，出现在任务板上", async () => {
    const res = await post({ text: "给 Meegle 连接器写测试", due: "2026-09-05" });
    expect(res.status).toBe(201);
    const task = (await res.json()) as Task;
    expect(task).toMatchObject({ title: "给 Meegle 连接器写测试", kind: "verbal", status: "understood", due: "2026-09-05" });
    const board = (await (await app.request("/tasks")).json()) as TaskBoard;
    expect(board.tasks.some((t) => t.id === task.id)).toBe(true);
  });

  it("拒绝空文本和错误日期", async () => {
    expect((await post({ text: "" })).status).toBe(400);
    expect((await post({ text: "x", due: "明天" })).status).toBe(400);
  });
});
