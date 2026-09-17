import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@friday/shared";

const cardMock = vi.fn();
vi.mock("./card.js", () => ({ summonCard: cardMock, SUMMON_MODEL: "claude-sonnet-5" }));
vi.mock("../../memory/tasks.js", () => ({ listTasks: () => [] }));
vi.mock("../../memory/projects.js", () => ({ loadProjects: () => [] }));

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
  beforeEach(() => cardMock.mockReset());

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
