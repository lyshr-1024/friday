import { describe, expect, it } from "vitest";
import type { Task } from "@friday/shared";
import { MIN_OVERLAP, matchChannelTask, overlapLen } from "./channelMatch.js";

const task = (id: string, title: string): Task => ({
  id, title, kind: "meegle", source: {}, status: "understood",
  priority: "normal", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z",
});

describe("overlapLen", () => {
  it("频道名几乎就是需求名", () => {
    expect(overlapLen("#财富首页新增whatsapp入口-需求", "财富首页新增whatsapp入口")).toBeGreaterThanOrEqual(16);
  });

  it("需求名被【】包着也能对上", () => {
    expect(overlapLen("#需求管理-邀请达标不发奖", "【邀请达标不发奖】【BO】奖励发放补偿")).toBe(7);
  });

  it("中间隔字的算不上贴合", () => {
    expect(overlapLen("#一起养牛", "养牛计划1.0")).toBeLessThan(MIN_OVERLAP);
  });

  it("只共同几个字是巧合", () => {
    expect(overlapLen("#活动ai-agent大赛需求群", "【AI 助理养成赛】赛事页面")).toBeLessThan(MIN_OVERLAP);
  });

  it("去掉 proj- 前缀再比", () => {
    expect(overlapLen("proj-财富首页新增whatsapp入口", "财富首页新增whatsapp入口")).toBe(16);
  });
});

describe("matchChannelTask", () => {
  const tasks = [
    task("t1", "财富首页新增whatsapp入口"),
    task("t2", "【邀请达标不发奖】【BO】奖励发放补偿"),
    task("t3", "养牛计划1.0"),
    task("t4", "【AI 助理养成赛】赛事页面"),
  ];

  it("whatsapp 入口这条能中", () => {
    const hit = matchChannelTask("#财富首页新增whatsapp入口-需求", tasks);
    expect(hit?.taskId).toBe("t1");
    expect(hit?.why).toContain("财富首页新增whatsapp入口");
  });

  it("邀请达标不发奖这条能中", () => {
    expect(matchChannelTask("#需求管理-邀请达标不发奖", tasks)?.taskId).toBe("t2");
  });

  it("一起养牛对不上养牛计划1.0", () => {
    expect(matchChannelTask("#一起养牛", tasks)).toBeUndefined();
  });

  it("大赛需求群对不上助理养成赛", () => {
    expect(matchChannelTask("#活动ai-agent大赛需求群", tasks)).toBeUndefined();
  });

  it("多条都够长时取最长的", () => {
    const hit = matchChannelTask("#财富首页新增whatsapp入口", [task("a", "财富首页新增whatsapp"), task("b", "财富首页新增whatsapp入口")]);
    expect(hit?.taskId).toBe("b");
  });

  it("没有任务时不中", () => {
    expect(matchChannelTask("#一起养牛", [])).toBeUndefined();
  });
});
