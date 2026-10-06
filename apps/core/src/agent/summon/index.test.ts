import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@friday/shared";

const cardMock = vi.fn();
vi.mock("./card.js", () => ({ summonCard: cardMock, SUMMON_MODEL: "sonnet" }));
vi.mock("../../memory/tasks.js", () => ({ listTasks: () => [] }));
vi.mock("../../memory/projects.js", async (orig) => ({ ...(await orig<object>()), loadProjects: () => [] }));
const larkMock = vi.fn();
vi.mock("../../connectors/lark.js", async (orig) => ({ ...(await orig<object>()), fetchLarkDoc: larkMock }));

const { summon, trimUrl } = await import("./index.js");

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: Date.now(),
    app: { bundleId: "com.apple.finder", name: "Finder", title: "下载" },
    permissions: { accessibility: true, automation: true, screen: true },
    ...over,
  };
}

describe("summon", () => {
  beforeEach(() => {
    cardMock.mockReset();
    larkMock.mockReset();
  });

  it("开着企业租户的 Lark 文档：正文走 lark-cli，节选进模型卡；规则卡先发不等它", async () => {
    larkMock.mockResolvedValue({ title: "新的WBO后台验收-1006", outline: ["新后台链接", "1005验收新问题"], text: "入金申请 | 这些状态筛选还是需要的" });
    cardMock.mockResolvedValue({ verdict: "x", actions: [] });
    const events: string[] = [];
    for await (const ev of summon(snap({ app: { bundleId: "com.google.Chrome", name: "Chrome", title: "新的WBO后台验收-1006 - Lark云文档" }, browser: { url: "https://longbridge-group.jp.larksuite.com/docx/NWpXdmf6zo5Q", title: "新的WBO后台验收-1006" } }))) events.push(ev.type);
    expect(events[0]).toBe("rules");
    expect(larkMock).toHaveBeenCalledWith("https://longbridge-group.jp.larksuite.com/docx/NWpXdmf6zo5Q", { timeoutMs: 3000 });
    const input = cardMock.mock.calls[0]![0] as { doc?: string; source?: string };
    expect(input.source).toContain("Lark");
    expect(input.doc).toContain("大纲：新后台链接 / 1005验收新问题");
    expect(input.doc).toContain("这些状态筛选还是需要的");
  });

  it("不在白名单的 Lark 域名：URL 被削成 host，不去拉正文", async () => {
    cardMock.mockResolvedValue({ verdict: "x", actions: [] });
    for await (const _ of summon(snap({ browser: { url: "https://someone.larksuite.com/docx/ABC", title: "私人文档" } }))) void _;
    expect(larkMock).not.toHaveBeenCalled();
  });

  it("先发 rules 再发 done", async () => {
    const events = [];
    for await (const ev of summon(snap())) events.push(ev);
    expect(events[0]!.type).toBe("rules");
    expect(events.at(-1)!.type).toBe("done");
  });

  it("没有任何文字也照样调模型——那正是最该动脑的时候", async () => {
    cardMock.mockResolvedValue({ verdict: "这跟你的工作没关系", actions: [] });
    for await (const _ of summon(snap())) void _;
    expect(cardMock).toHaveBeenCalledOnce();
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

describe("trimUrl", () => {
  const allow = ["meegle.com", "longbridge.sg"];

  it("白名单内的网址原样保留", () => {
    const sn = snap({ browser: { url: "https://project.meegle.com/x/issue/detail/1234", title: "工单" } });
    expect(trimUrl(sn, allow).browser).toEqual(sn.browser);
  });

  it("白名单外只留域名，路径与 query 都丢掉", () => {
    const sn = snap({ browser: { url: "https://bank.example.com/account?token=secret", title: "我的账户" } });
    expect(trimUrl(sn, allow).browser).toEqual({ url: "bank.example.com", title: "" });
  });

  it("子域算命中", () => {
    const sn = snap({ browser: { url: "https://a.longbridge.sg/p?q=1", title: "t" } });
    expect(trimUrl(sn, allow).browser?.url).toBe("https://a.longbridge.sg/p?q=1");
  });

  // 报错文字里常带完整接口地址和参数，白名单外一起丢掉
  it("白名单外的页面报错也一起丢掉", () => {
    const sn = snap({ browser: { url: "https://bank.example.com/a", title: "t", errors: ["500 https://bank.example.com/api?token=secret"] } });
    expect(trimUrl(sn, allow).browser?.errors).toBeUndefined();
  });

  it("白名单内的页面报错留着", () => {
    const sn = snap({ browser: { url: "https://project.meegle.com/x", title: "t", errors: ["请求失败"] } });
    expect(trimUrl(sn, allow).browser?.errors).toEqual(["请求失败"]);
  });

  it("非法 URL 整个清掉", () => {
    const sn = snap({ browser: { url: "不是网址", title: "t" } });
    expect(trimUrl(sn, allow).browser).toEqual({ url: "", title: "" });
  });
});

describe("trimUrl 与项目地址", () => {
  it("项目注册表里登记过的域名保留完整路径", () => {
    const sn = snap({ browser: { url: "https://console.longbridge.xyz/opa/next/cattle-activities/create", title: "养牛活动" } });
    expect(trimUrl(sn, ["console.longbridge.xyz"]).browser?.url).toContain("cattle-activities");
  });
});
