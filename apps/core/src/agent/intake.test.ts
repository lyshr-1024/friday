import { describe, expect, it } from "vitest";
import { intakePrompt, parseIntake, plainBody, tooThin } from "./intake.js";
import type { Project } from "../memory/projects.js";

const projects: Project[] = [
  { name: "whale-console", dir: "/w", aliases: ["后台", "BO"], channels: [], urls: ["console.longbridge.xyz/wbo"] },
  { name: "fe-wealth-admin", dir: "/f", aliases: ["财富后台"], channels: [], urls: [] },
];

describe("工单进来判断能不能直接做", () => {
  it("start 必须指向注册表里真实存在的项目", () => {
    const ok = parseIntake('{"kind":"start","project":"whale-console","detail":"复现步骤…","confidence":85,"why":"缺陷写得清楚"}', projects);
    expect(ok).toMatchObject({ kind: "start", project: "whale-console", confidence: 85 });
    // 编了个不存在的项目就退回排队，不能拿去 resolveProject
    const bad = parseIntake('{"kind":"start","project":"不存在的项目","detail":"x","why":"y"}', projects);
    expect(bad.kind).toBe("queue");
    expect(bad.why).toContain("注册表里没有");
  });

  it("没给置信度或给了非法值当 0——宁可落在阈值下面挂起，也不因字段缺失就开工", () => {
    expect(parseIntake('{"kind":"start","project":"whale-console","detail":"x","why":"y"}', projects)).toMatchObject({ confidence: 0 });
    expect(parseIntake('{"kind":"start","project":"whale-console","detail":"x","confidence":"高","why":"y"}', projects)).toMatchObject({ confidence: 0 });
    // 超出范围的夹到 0-100
    expect(parseIntake('{"kind":"start","project":"whale-console","detail":"x","confidence":150,"why":"y"}', projects)).toMatchObject({ confidence: 100 });
  });

  it("start 没给 detail 就不算数", () => {
    expect(parseIntake('{"kind":"start","project":"whale-console","detail":"  ","why":"x"}', projects).kind).toBe("queue");
  });

  it("ask 要带问题，空问题退回排队", () => {
    expect(parseIntake('{"kind":"ask","question":"这条工单是哪个项目的？","why":"归不到项目"}', projects)).toMatchObject({ kind: "ask", question: "这条工单是哪个项目的？" });
    expect(parseIntake('{"kind":"ask","question":"","why":"x"}', projects).kind).toBe("queue");
  });

  it("解析不出来一律排队，不猜", () => {
    expect(parseIntake("这条我觉得可以做", projects).kind).toBe("queue");
    expect(parseIntake('{"kind":"start"', projects).kind).toBe("queue");
  });

  it("描述太短直接排队；链接、图片元数据、HTML 都不算正文", () => {
    expect(tooThin("", { understanding: "" })).toBe(true);
    expect(tooThin("https://project.larksuite.com/x/1 https://a.b/c", { understanding: "" })).toBe(true);
    // 库里真实存在这种：74 字全是图片元数据，一个字正文都没有
    expect(tooThin('![]( image:{"width":820,"uuid":"2C059D2B-0C1E-4F6F-A099-1234567890AB"})', { understanding: "" })).toBe(true);
    expect(tooThin('<span style="font-size: 12px"><span style="color: #FF0000"></span></span>', { understanding: "" })).toBe(true);
    expect(tooThin("【问题描述】后台复制任务包后阶梯奖励状态错误，且无法编辑删除", { understanding: "" })).toBe(false);
  });

  it("plainBody 剥掉噪音留下正文", () => {
    expect(plainBody('![]( image:{"uuid":"X"}) 【问题描述】复制后状态错误')).toBe("【问题描述】复制后状态错误");
    expect(plainBody("<span>文字</span> &nbsp; [ linkPreview --> ")).toBe("文字 -->");
  });

  it("提示词带上注册表和工单正文，并要求宁可排队也不硬猜", () => {
    const { system, prompt } = intakePrompt(
      { title: "【BO】收盘价输入错误提示待优化", understanding: "Meegle 缺陷 #1，分派给你", project: undefined },
      "【问题描述】输入负数没有提示",
      projects,
    );
    expect(prompt).toContain("【BO】收盘价");
    expect(prompt).toContain("输入负数没有提示");
    expect(prompt).toContain("还没归到项目");
    expect(system).toContain("whale-console");
    expect(system).toContain("宁可 queue 也不要硬猜");
  });
});
