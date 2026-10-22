import { describe, expect, it } from "vitest";
import { friday } from "./prompt.js";

describe("系统提示", () => {
  it("绑了任务的会话把卡片当第一上下文注入", () => {
    const s = friday(undefined, false, "任务：修登录（processing）\n进展：改到一半");
    expect(s).toContain("【任务板】");
    expect(s).toContain("修登录");
    expect(s).toContain("对不上就反问");
    expect(s).not.toContain("【当前任务】");
    expect(s).not.toContain("用户说的话默认都是关于它的");
    expect(friday(undefined, false)).not.toContain("【任务板】");
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
});
