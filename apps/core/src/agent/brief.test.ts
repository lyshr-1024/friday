import { describe, expect, it } from "vitest";
import { parseBrief, briefPrompt } from "./brief.js";
import { meegleLookups, personNote } from "./enrich.js";
import { upsertPerson } from "./autowrite.js";

describe("情境卡", () => {
  it("解析 JSON、规范字段、越界截断", () => {
    const b = parseBrief('好的 {"situation":"灵雨追问 Meegle #1 登录报错，工单还在 Open","needs":"看报错并回复","needsReply":true,"urgency":"high","reply":"我看到了，工单还在 Open，我今天下午修","actions":[{"type":"reply","label":"回复"},{"type":"bogus","label":"x"}],"context":["工单 #1 Open"],"todo":{"text":"修登录报错","due":"2026-09-08"},"person":"负责 BO 测试"}')!;
    expect(b.needsReply).toBe(true);
    expect(b.actions.map((a) => a.type)).toEqual(["reply", "none"]);
    expect(b.todo).toEqual({ text: "修登录报错", due: "2026-09-08" });
    expect(b.person).toBe("负责 BO 测试");
    expect(parseBrief("没有 json")).toBeUndefined();
  });

  it("提示词带上人物、历史、链接与项目 git 背景", () => {
    const { prompt } = briefPrompt(
      { id: "t", kind: "dm", userId: "U", userName: "灵雨", channelId: "D", channelName: "私聊", status: "open", firstTs: "1", lastTs: "1", updatedAt: "", items: [{ id: "a", kind: "dm", channelId: "D", channelName: "私聊", userId: "U", userName: "灵雨", text: "看下这个", permalink: "", ts: "1760000000", receivedAt: "", done: false }] },
      { history: ["上次问过登录报错"], person: "灵雨：QA", links: ["Meegle 缺陷 #1「登录报错」状态 Open"], project: { name: "whale-console", dir: "/w", git: "分支：main；工作区干净" }, context: [] },
    );
    expect(prompt).toContain("上次问过登录报错");
    expect(prompt).toContain("Meegle 缺陷 #1");
    expect(prompt).toContain("whale-console");
  });

  it("指代句要带上频道前文，否则判断不出说的是哪件事", () => {
    const { system, prompt } = briefPrompt(
      { id: "t", kind: "mention", userId: "U", userName: "jiacheng.zhou", channelId: "C", channelName: "#银河", status: "open", firstTs: "1", lastTs: "1", updatedAt: "", items: [{ id: "a", kind: "mention", channelId: "C", channelName: "#银河", userId: "U", userName: "jiacheng.zhou", text: "你看看志华遗留的这个问题", permalink: "", ts: "1760000000", receivedAt: "", done: false }] },
      { history: [], links: [], context: [{ ts: "1759999000", userName: "fen.cai", text: "多级标题在 iOS 上错位了" }] },
    );
    expect(prompt).toContain("多级标题在 iOS 上错位了");
    expect(prompt).toContain("这之前");
    expect(system).toContain("指代句");
  });
});

describe("做功课", () => {
  it("Meegle 链接经 project search + workitem get 解析成一句话", async () => {
    const calls: string[][] = [];
    const run = async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "project") return { projects: [{ project_key: "PK1" }] };
      return { work_item_attribute: { work_item_name: " 登录报错 ", work_item_status: { name: "Open" }, work_item_type: { name: "缺陷" }, role_members: [{ name: "Assignee", members: [{ name: "浩然" }] }] }, work_item_fields: [{ key: "priority", value: { label: "P1" } }] };
    };
    const out = await meegleLookups("看下 https://project.larksuite.com/projectlb/issue/detail/24397523 谢谢", run as never);
    expect(out).toEqual(["Meegle 缺陷 #24397523「登录报错」状态 Open，P1，负责人 浩然"]);
    expect(calls[1]).toContain("24397523");
  });

  it("people.md 按名字匹配；upsert 追加备注或新建条目", () => {
    const people = "# 人物\n\n## 灵雨 (Hu Xuefang)\n- 角色：QA\n- 联系：Slack\n\n## 大黄\n- 角色：后端\n";
    expect(personNote("灵雨 (Hu Xuefang)", people)).toBe("灵雨 (Hu Xuefang)：角色：QA；联系：Slack");
    expect(personNote("Zhou Jiwei", people)).toBeUndefined();
    let written = "";
    const line = upsertPerson("大黄", "常来问权限策略", people, (_n, content) => { written = content; });
    expect(line).toMatch(/^- 备注（\d{4}-\d{2}-\d{2}，Friday 自动）：常来问权限策略$/);
    expect(written).toMatch(/## 大黄\n- 角色：后端\n- 备注（\d{4}-\d{2}-\d{2}，Friday 自动）：常来问权限策略\n/);
    upsertPerson("新人", "刚来的前端", people, (_n, content) => { written = content; });
    expect(written.trim().endsWith("## 新人\n- 备注（" + new Date().toISOString().slice(0, 10) + "，Friday 自动）：刚来的前端")).toBe(true);
  });
});
