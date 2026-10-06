import { beforeEach, describe, expect, it, vi } from "vitest";
import { docExcerpt, fetchLarkDoc, markdownToText, parseLarkFetch, resetLarkCache, type LarkRunner } from "./lark.js";

const content = [
  "<title>新的WBO后台验收-1006</title>",
  "",
  "# 验收文档",
  "",
  '<cite doc-id="D1" title="Whale Console · WBO 菜单迁移进度总表" type="doc"></cite>',
  "",
  "# 新后台链接",
  "",
  "https://console.longbridge.xyz/x/wbo/atm/accounting/deposits?invisible=0",
  "",
  "# 1005验收新问题",
  "",
  '<table><thead><tr><th>验收目录</th><th>问题</th></tr></thead><tbody><tr><td>入金申请</td><td><ol><li seq="1">这些状态筛选还是需要的</li></ol><img name="image.png" alt="The image shows the &#34;入金&#34; page"/></td></tr><tr><td>入金匹配</td><td>1.<del>菜单解释没有</del></td></tr></tbody></table>',
].join("\n");
const raw = JSON.stringify({ ok: true, data: { document: { content, document_id: "NWp", revision_id: 7 } } });

describe("Lark 文档", () => {
  beforeEach(() => resetLarkCache());

  it("解析成标题 / 大纲 / 纯文本：表格一格一段、截图留 alt、引用留标题", () => {
    const doc = parseLarkFetch(raw)!;
    expect(doc.title).toBe("新的WBO后台验收-1006");
    expect(doc.outline).toEqual(["验收文档", "新后台链接", "1005验收新问题"]);
    expect(doc.revision).toBe(7);
    expect(doc.text).toContain("[引用：Whale Console · WBO 菜单迁移进度总表]");
    expect(doc.text).toContain("https://console.longbridge.xyz/x/wbo/atm/accounting/deposits?invisible=0");
    expect(doc.text).toContain("入金申请 | 这些状态筛选还是需要的");
    expect(doc.text).toContain('[图：The image shows the "入金" page]');
    expect(doc.text).toContain("入金匹配 | 1.~菜单解释没有~");
    expect(doc.text).not.toMatch(/<[a-z]/);
  });

  it("不是 JSON 或没有正文返回 undefined", () => {
    expect(parseLarkFetch("Error: not logged in")).toBeUndefined();
    expect(parseLarkFetch(JSON.stringify({ ok: false }))).toBeUndefined();
  });

  it("按文档缓存：同一篇五分钟内不再调 CLI，查询串不同也算同一篇", async () => {
    const run = vi.fn<LarkRunner>(async () => raw);
    const url = "https://longbridge-group.jp.larksuite.com/docx/NWp";
    await fetchLarkDoc(url, { run, now: 1000 });
    await fetchLarkDoc(`${url}?from=copylink`, { run, now: 2000 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual(["docs", "+fetch", "--doc", url, "--doc-format", "markdown"]);
    await fetchLarkDoc(url, { run, now: 1000 + 6 * 60 * 1000 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("CLI 失败或超时返回 undefined，不让呼出失败", async () => {
    const run = vi.fn<LarkRunner>(async () => { throw new Error("ETIMEDOUT"); });
    expect(await fetchLarkDoc("https://x.larksuite.com/docx/A", { run })).toBeUndefined();
  });

  it("节选：大纲全带，有选中文字就给它附近那段，没有就给开头", () => {
    const doc = { title: "T", outline: ["一", "二"], text: `${"甲".repeat(3000)}这些状态筛选还是需要的${"乙".repeat(3000)}` };
    const picked = docExcerpt(doc, "这些状态筛选", 1200);
    expect(picked).toContain("大纲：一 / 二");
    expect(picked).toContain("这些状态筛选还是需要的");
    expect(picked.length).toBeLessThan(1500);
    const head = docExcerpt(doc, undefined, 1200);
    expect(head).toContain("甲甲甲");
    expect(head).not.toContain("乙");
  });

  it("markdownToText 保留 markdown 标题行", () => {
    expect(markdownToText("# 标题\n\n<p>正文</p>")).toBe("# 标题\n\n正文");
  });
});
