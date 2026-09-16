import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@friday/shared";

const cardMock = vi.fn();
vi.mock("./card.js", () => ({ summonCard: cardMock, SUMMON_MODEL: "claude-sonnet-5" }));
vi.mock("../../memory/tasks.js", () => ({ listTasks: () => [] }));
vi.mock("../../memory/projects.js", () => ({ loadProjects: () => [] }));

const { summon } = await import("./index.js");

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: Date.now(),
    app: { bundleId: "com.apple.finder", name: "Finder", title: "下载" },
    permissions: { accessibility: true, automation: true, screen: true },
    ...over,
  };
}

describe("summon", () => {
  beforeEach(() => cardMock.mockReset());

  it("先发 rules 再发 done", async () => {
    const events = [];
    for await (const ev of summon(snap())) events.push(ev);
    expect(events[0]!.type).toBe("rules");
    expect(events.at(-1)!.type).toBe("done");
  });

  it("没有任何文字时不调模型", async () => {
    for await (const _ of summon(snap())) void _;
    expect(cardMock).not.toHaveBeenCalled();
  });

  it("有选中文字时调模型并发 card", async () => {
    cardMock.mockResolvedValue({ verdict: "这是一段报错", actions: [] });
    const events = [];
    for await (const ev of summon(snap({ selection: "TypeError: x is not a function" }))) events.push(ev);
    expect(cardMock).toHaveBeenCalledOnce();
    expect(events.map((e) => e.type)).toContain("card");
  });

  it("模型抛错时发 error 但仍然 done", async () => {
    // mockRejectedValue 会被 vitest 4.1.11 的全局 unhandled-rejection 监听器误报，Once 语义等价
    cardMock.mockRejectedValueOnce(new Error("超时"));
    const events = [];
    for await (const ev of summon(snap({ selection: "x" }))) events.push(ev);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)!.type).toBe("done");
  });
});
