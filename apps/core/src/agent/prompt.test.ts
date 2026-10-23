import { afterEach, describe, expect, it, vi } from "vitest";
import { friday } from "./prompt.js";

afterEach(() => vi.useRealTimers());

describe("系统提示", () => {
  it("改自己行为：配置调不了的在 friday 项目上建任务", () => {
    expect(friday(undefined, false)).toContain("在 friday 项目上建一条任务");
  });

  it("绑了任务的会话把卡片当第一上下文注入", () => {
    const s = friday(undefined, false, "任务：修登录（processing）\n进展：改到一半");
    expect(s).toContain("【任务板】");
    expect(s).toContain("修登录");
    expect(s).toContain("对不上就反问");
    expect(s).not.toContain("【当前任务】");
    expect(s).not.toContain("用户说的话默认都是关于它的");
    expect(friday(undefined, false)).not.toContain("【任务板】");
  });

  it("换了新会话时带上最近的对话，围栏包住；没给就不出这一段", () => {
    const s = friday(undefined, false, undefined, undefined, "用户：把遗留的清了\nFriday：要删这 5 个，回「删掉」");
    expect(s).toContain("【刚才的对话】");
    expect(s).toContain('<untrusted source="主对话最近几条">');
    expect(s).toContain("Friday：要删这 5 个，回「删掉」");
    expect(friday(undefined, false)).not.toContain("【刚才的对话】");
  });

  it("要点头的事用正常的话问，不让用户背固定的词", () => {
    const s = friday(undefined, false);
    expect(s).toContain("绝不让他回某个固定的词");
    expect(s).toContain("一句同意对这几条都有效");
  });

  it("task_start 描述不再带 mode，路由段说明「收下」指批准", () => {
    const s = friday(undefined, false);
    expect(s).not.toContain("mode=interactive");
    expect(s).toContain("task_start 给点名的任务开工（Friday 驾驶，中途可插话）");
    expect(s).toContain("“收下”“可以了”指批准这条待审的合并或发送");
  });

  it("转达纪律：终端关了就 task_start，不再指到 run_claude", () => {
    const s = friday(undefined, false);
    expect(s).toContain("不要说它还在跑");
    expect(s).toContain("task_start");
    expect(s).not.toContain("run_claude 重新开");
  });

  it("带任务板时不再注入【未完成待办】，不带时照旧", () => {
    const memory = { projects: "p", todos: "- 写周报", hasPeople: false, hasDecisions: false, handbooks: [] };
    expect(friday(memory, false, "任务板内容")).not.toContain("【未完成待办】");
    expect(friday(memory, false, "任务板内容")).toContain("【项目注册表】");
    expect(friday(memory, false)).toContain("【未完成待办】\n- 写周报");
  });

  it("时间只到分钟（上海时区），同一分钟内系统提示不变", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T08:37:42Z"));
    const a = friday(undefined, false);
    expect(a).toContain("现在是 2026-10-22 16:37。");
    vi.setSystemTime(new Date("2026-10-22T08:37:59Z"));
    expect(friday(undefined, false)).toBe(a);
  });
});

describe("项目登记提示", () => {
  it("memory_write 只写 decisions / people，项目登记指向 project_update", () => {
    const s = friday(undefined, false);
    expect(s).toContain("project_update");
    expect(s).not.toContain("memory_read / memory_write 读写");
    expect(s).toContain("memory_write 整篇写 decisions / people");
  });
});
