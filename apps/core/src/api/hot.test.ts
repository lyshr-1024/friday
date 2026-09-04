import { describe, expect, it, vi } from "vitest";
import type { HotResponse } from "@friday/shared";

vi.mock("../connectors/news.js", async (orig) => {
  const mod = await orig<typeof import("../connectors/news.js")>();
  const now = new Date().toISOString();
  return {
    ...mod,
    SOURCES: [
      { source: "hn", fetch: async () => [{ title: "GPT-6 released", url: "https://a/1", source: "hn", publishedAt: now, score: 900 }] },
      { source: "hf", fetch: async () => [{ title: "Paper X", url: "https://a/2", source: "hf", publishedAt: now, snippet: "abstract" }] },
      { source: "qbitai", fetch: async () => { throw new Error("网络超时"); } },
    ],
  };
});
vi.mock("../agent/claude.js", () => ({
  askStream: async function* () {
    yield { type: "delta", text: '好的，结果：[{"index":2,"title":"论文 X","summary":"值得看"},{"index":1,"title":"GPT-6 发布","summary":"大新闻"}]' };
    yield { type: "done" };
  },
}));

const { app } = await import("./index.js");

describe("GET /hot", () => {
  it("合并各源、由 Claude 挑选并回填链接，失败的源记入 sourceErrors，结果有缓存", async () => {
    const res = (await (await app.request("/hot")).json()) as HotResponse;
    expect(res.items.map((i) => [i.title, i.url, i.source])).toEqual([
      ["论文 X", "https://a/2", "hf"],
      ["GPT-6 发布", "https://a/1", "hn"],
    ]);
    expect(res.sourceErrors).toEqual({ qbitai: "网络超时" });
    const again = (await (await app.request("/hot")).json()) as HotResponse;
    expect(again.generatedAt).toBe(res.generatedAt);
  });
});
