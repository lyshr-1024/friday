import { describe, expect, it } from "vitest";
import { fresh, parseFeed } from "./news.js";

describe("RSS / Atom 解析", () => {
  it("解析 RSS item 与 Atom entry，CDATA 与实体解码", () => {
    const rss = `<rss><channel><item><title><![CDATA[量子位 &amp; AI]]></title><link>https://q/1</link><pubDate>Thu, 04 Sep 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>摘要 <b>加粗</b></p>]]></description></item></channel></rss>`;
    const atom = `<feed><entry><title>Atom 条目</title><link rel="alternate" href="https://s/2"/><published>2026-09-04T01:00:00Z</published><summary>摘要</summary></entry></feed>`;
    expect(parseFeed(rss, "qbitai")).toEqual([
      { title: "量子位 & AI", url: "https://q/1", source: "qbitai", publishedAt: "2026-09-04T08:00:00.000Z", snippet: "摘要 加粗" },
    ]);
    expect(parseFeed(atom, "simonw")[0]).toMatchObject({ title: "Atom 条目", url: "https://s/2", publishedAt: "2026-09-04T01:00:00.000Z" });
  });

  it("只保留 48 小时内的条目", () => {
    const now = Date.parse("2026-09-04T12:00:00Z");
    const items = [
      { title: "新", url: "u1", source: "hn" as const, publishedAt: "2026-09-03T13:00:00Z" },
      { title: "旧", url: "u2", source: "hn" as const, publishedAt: "2026-09-01T12:00:00Z" },
    ];
    expect(fresh(items, now).map((i) => i.title)).toEqual(["新"]);
  });
});
