import { describe, expect, it } from "vitest";
import type { Snapshot, SummonRules } from "@friday/shared";
import { cardPrompt, parseCard } from "./card.js";

const allowed = { taskIds: ["t1"], actionIds: ["a1"], projects: ["whale-console"] };

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
});

describe("cardPrompt", () => {
  it("外部文字被定界符包住", () => {
    const { prompt } = cardPrompt({ snapshot, rules, candidates: [] });
    expect(prompt).toContain("养牛活动验收问题抽空改一改");
    expect(prompt).toContain('<untrusted source="用户选中的文字">');
  });

  it("system 里写明只能用给定的动作类型", () => {
    const { system } = cardPrompt({ snapshot, rules, candidates: [] });
    expect(system).toContain("open_task");
    expect(system).toContain("start_work");
  });
});
