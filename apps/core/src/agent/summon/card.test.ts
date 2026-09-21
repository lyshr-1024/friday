import { describe, expect, it } from "vitest";
import type { Snapshot, SummonRules } from "@friday/shared";
import { type AllowedIds, cardPrompt, parseCard } from "./card.js";

const allowed: AllowedIds = { taskIds: ["t1", "t2"], actionIds: { t1: { a1: "slack_reply" }, t2: { a2: "git_merge" } }, projects: ["whale-console"] };

const snapshot: Snapshot = {
  at: 0,
  app: { bundleId: "com.tinyspeck.slackmacgap", name: "Slack", title: "#wealth-fe - Slack" },
  selection: "养牛活动验收问题抽空改一改",
  permissions: { accessibility: true, automation: true, screen: true },
};

const rules: SummonRules = { saw: "Slack · #wealth-fe", actions: [], willThink: true };

describe("parseCard", () => {
  it("解析正常输出", () => {
    const card = parseCard('{"verdict":"拂晓在催验收","reply":"我下午改","actions":[{"kind":"open_task","label":"打开","taskId":"t1"}],"matchTaskId":"t1"}', allowed);
    expect(card.verdict).toBe("拂晓在催验收");
    expect(card.actions).toHaveLength(1);
    expect(card.matchTaskId).toBe("t1");
  });

  it("钳掉不存在的 taskId", () => {
    const card = parseCard('{"verdict":"x","actions":[{"kind":"open_task","label":"打开","taskId":"bogus"}]}', allowed);
    expect(card.actions).toEqual([]);
    expect(card.matchTaskId).toBeUndefined();
  });

  it("钳掉模型自己发明的动作类型", () => {
    const card = parseCard('{"verdict":"x","actions":[{"kind":"send_email","label":"发邮件"}]}', allowed);
    expect(card.actions).toEqual([]);
  });

  it("start_work 的项目必须在白名单里", () => {
    const ok = parseCard('{"verdict":"x","actions":[{"kind":"start_work","label":"开工","project":"whale-console","prompt":"改 tab"}]}', allowed);
    expect(ok.actions).toHaveLength(1);
    const bad = parseCard('{"verdict":"x","actions":[{"kind":"start_work","label":"开工","project":"别的项目","prompt":"x"}]}', allowed);
    expect(bad.actions).toEqual([]);
  });

  it("最多留 3 个动作", () => {
    const four = Array.from({ length: 4 }, () => '{"kind":"open_task","label":"打开","taskId":"t1"}').join(",");
    expect(parseCard(`{"verdict":"x","actions":[${four}]}`, allowed).actions).toHaveLength(3);
  });

  it("不是 JSON 时返回空判断而不是抛", () => {
    expect(parseCard("模型今天不想说话", allowed)).toEqual({ verdict: "", actions: [] });
  });

  it("taskId 和 actionId 分属不同任务时钳掉", () => {
    const card = parseCard('{"verdict":"x","actions":[{"kind":"approve_pending","label":"通过","taskId":"t1","actionId":"a2"}]}', allowed);
    expect(card.actions).toEqual([]);
  });

  it("markdown 围栏加后缀说明文字仍能解析", () => {
    const text = '```json\n{"verdict":"拂晓在催验收","actions":[]}\n```\n补充说明 {还有花括号}';
    const card = parseCard(text, allowed);
    expect(card.verdict).toBe("拂晓在催验收");
    expect(card.actions).toEqual([]);
  });
});

describe("cardPrompt", () => {
  it("外部文字被定界符包住", () => {
    const { prompt } = cardPrompt({ snapshot, rules, candidates: [] });
    expect(prompt).toContain("养牛活动验收问题抽空改一改");
    expect(prompt).toContain('<untrusted source="用户此刻在做什么">');
  });

  it("频道实时消息在定界符内", () => {
    const scene = "频道 #team-fe-bo 最近在聊：\n  佳成：菜单去掉 anyOf";
    const { prompt } = cardPrompt({ snapshot, rules, candidates: [], scene });
    const block = /<untrusted source="用户此刻在做什么">([\s\S]*?)<\/untrusted>/.exec(prompt)?.[1] ?? "";
    expect(block).toContain("菜单去掉 anyOf");
  });

  it("system 里写明只能用给定的动作类型", () => {
    const { system } = cardPrompt({ snapshot, rules, candidates: [] });
    expect(system).toContain("open_task");
    expect(system).toContain("start_work");
  });

  it("候选任务的标题在定界符内", () => {
    const candidates = [{ task: { id: "t1", title: "养牛活动验收", status: "review" } as any, why: "同一件事", strength: "sure" as const }];
    const { prompt } = cardPrompt({ snapshot, rules, candidates });
    const block = /<untrusted source="可能相关的任务">([\s\S]*?)<\/untrusted>/.exec(prompt)?.[1] ?? "";
    expect(block).toContain("养牛活动验收");
  });
});

describe("页面报错进上下文", () => {
  it("报错和失败请求都带给模型，且在不可信定界符里", () => {
    const withErrors: Snapshot = {
      ...snapshot,
      app: { bundleId: "com.google.Chrome", name: "Chrome", title: "资金参数" },
      browser: { url: "https://console.longbridge.xyz/x/wbo/funds", title: "资金参数", errors: ["请求失败，请稍后重试", "500 https://api.x/params"] },
    };
    const { prompt } = cardPrompt({ snapshot: withErrors, rules, candidates: [] });
    expect(prompt).toContain("页面上的报错与失败请求");
    expect(prompt).toContain("请求失败，请稍后重试");
    expect(prompt).toContain("500 https://api.x/params");
  });

  it("没有报错时不提这一段", () => {
    const { prompt } = cardPrompt({ snapshot, rules, candidates: [] });
    expect(prompt).not.toContain("页面上的报错");
  });
});

describe("meegle_add", () => {
  const onTicket: AllowedIds = { ...allowed, browserUrl: "https://project.larksuite.com/sp/story/detail/8899" };

  it("url 与当前快照一致才放行", () => {
    const card = parseCard(
      '{"verdict":"x","actions":[{"kind":"meegle_add","label":"加进任务板","url":"https://project.larksuite.com/sp/story/detail/8899"}]}',
      onTicket,
    );
    expect(card.actions).toEqual([{ kind: "meegle_add", label: "加进任务板", url: "https://project.larksuite.com/sp/story/detail/8899" }]);
  });

  // 模型编一个工单链接就会去拉别人的工单建成任务
  it("模型编的 url 一律钳掉", () => {
    const card = parseCard('{"verdict":"x","actions":[{"kind":"meegle_add","label":"加","url":"https://project.larksuite.com/sp/story/detail/1111"}]}', onTicket);
    expect(card.actions).toEqual([]);
  });

  it("没开浏览器时这个动作根本不成立", () => {
    const card = parseCard('{"verdict":"x","actions":[{"kind":"meegle_add","label":"加","url":"https://project.larksuite.com/sp/story/detail/8899"}]}', allowed);
    expect(card.actions).toEqual([]);
  });
});
