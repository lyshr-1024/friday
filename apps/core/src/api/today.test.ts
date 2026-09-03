import { describe, expect, it, vi } from "vitest";
import type { Todo } from "@friday/shared";

const remote: Todo[] = [
  { id: "meegle:1", text: "[P1 · Defect] A（Open）", source: "meegle", sourceUrl: "https://x/1", createdAt: "2026-09-01T00:00:00Z", done: false },
  { id: "meegle:2", text: "[P2 · Story] B（Open）", source: "meegle", sourceUrl: "https://x/2", createdAt: "2026-09-01T00:00:00Z", done: false },
];

vi.mock("../connectors/index.js", () => ({
  connectors: [{ source: "meegle", fetchTodos: async () => remote }],
}));
vi.mock("../agent/claude.js", () => ({
  askStream: async function* (prompt: string) {
    yield { type: "delta", text: `简报：${prompt.split("\n").length} 行输入` };
    yield { type: "done" };
  },
}));

const { app } = await import("./index.js");
const { addLocalTodo } = await import("../memory/todos.js");

describe("GET /today", () => {
  it("合并外部源与本地待办，生成简报", async () => {
    addLocalTodo({ text: "本地事项" });
    const res = await app.request("/today");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brief: string; todos: Todo[]; sourceErrors: Record<string, string> };
    expect(body.brief).toMatch(/^简报：/);
    expect(body.todos.map((t) => t.id).sort()).toEqual(expect.arrayContaining(["meegle:1", "meegle:2"]));
    expect(body.todos.some((t) => t.text === "本地事项")).toBe(true);
    expect(body.sourceErrors).toEqual({});
  });

  it("再次同步时消失的外部待办被标记完成，不重复插入", async () => {
    remote.pop();
    const body = (await (await app.request("/today")).json()) as { todos: Todo[] };
    const meegle = body.todos.filter((t) => t.source === "meegle");
    expect(meegle.map((t) => t.id)).toEqual(["meegle:1"]);
  });
});
