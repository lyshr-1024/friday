import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Task } from "@friday/shared";
import { addNoteTask, findSameThing } from "./noteTask.js";
import { createTask } from "./tasks.js";

beforeAll(() => {
  writeFileSync(
    join(process.env.FRIDAY_DATA_DIR!, "projects.md"),
    "## fe-wealth-admin\n- 目录：/tmp/fe\n- 别名：老后台, 社区\n\n## whale-console\n- 目录：/tmp/wc\n- 别名：后台, console\n",
  );
});

const mk = (title: string, project: string, extra: Partial<Parameters<typeof createTask>[0]> = {}): Task =>
  createTask({ title, kind: "meegle", source: {}, project, status: "understood", ...extra });

describe("口头交代先找已有的事", () => {
  it("话里带工单号，命中板上那条工单", () => {
    const t = mk("陪伴日记模板去掉三大指数收盘方向", "fe-wealth-admin", { source: { meegleId: "24519027" } });
    expect(findSameThing("24519027 这条今天要改完")?.id).toBe(t.id);
  });

  it("挂在需求下的缺陷，报需求号也能找到", () => {
    const t = mk("奖品图片必填缺红星", "fe-wealth-admin", { source: { meegleId: "24532477", linkedStoryId: "24440539" } });
    expect(findSameThing("养牛 24440539 的验收问题")?.id).toBe(t.id);
  });

  it("项目名 + 重合关键词算同一件事", () => {
    const t = mk("排查 whale-console 里 anyOf 服务端不识别的问题", "whale-console");
    expect(findSameThing("whale-console 那个 anyOf 的事记得跟进")?.id).toBe(t.id);
  });

  it("项目别名也认", () => {
    const t = mk("财富页多级标题配置回滚", "fe-wealth-admin");
    expect(findSameThing("老后台的多级标题回滚方案定了吗")?.id).toBe(t.id);
  });

  // 挂错地方比多建一条更难发现，所以宁可漏
  it("只有项目名、没有重合片段，不乱认", () => {
    mk("风控名单导入失败", "whale-console");
    expect(findSameThing("whale-console 要加个日历组件")).toBeUndefined();
  });

  it("只共享短词不算同一件事", () => {
    mk("报表打印的问题", "whale-console");
    expect(findSameThing("whale-console 结算的问题")).toBeUndefined();
  });

  it("跨项目不认：同样的关键词落在别的项目上不算一件事", () => {
    mk("多级标题配置回滚", "fe-wealth-admin");
    expect(findSameThing("whale-console 的多级标题配置回滚")).toBeUndefined();
  });

  it("已经收工的任务不会被一句话拽回来", () => {
    mk("清算对账单生成失败", "whale-console", { status: "done" });
    expect(findSameThing("whale-console 清算对账单的事")).toBeUndefined();
  });
});

describe("addNoteTask", () => {
  it("命中已有的事就补在它上面，不新建", () => {
    const t = mk("换汇额度校验漏了小数位", "whale-console", { understanding: "原始理解" });
    const got = addNoteTask({ text: "whale-console 换汇额度校验那条，顺带把提示文案也改了" });
    expect(got.id).toBe(t.id);
    expect(got.understanding).toContain("又交代");
    expect(got.understanding).toContain("原始理解");
  });

  it("认不出来就照常新建", () => {
    const got = addNoteTask({ text: "下周三之前把季度总结写了" });
    expect(got.title).toBe("下周三之前把季度总结写了");
    expect(got.status).toBe("understood");
  });
});

describe("会话里建任务", () => {
  it("要写代码的活带 stage，卡片上才有阶段", () => {
    const got = addNoteTask({ text: "修掉导出中心的空列表闪烁", stage: "todo", kind: "code", project: "whale-console" });
    expect(got.stage).toBe("todo");
    expect(got.kind).toBe("code");
    expect(got.project).toBe("whale-console");
  });

  it("纯提醒不给 stage", () => {
    const got = addNoteTask({ text: "周五之前交考勤" });
    expect(got.stage).toBeUndefined();
  });

  it("detail 写进理解，链接原样留着", () => {
    const link = "https://longbridge-group.jp.larksuite.com/wiki/Q9ezwwUSjiYS86kAErsjZw0Tp8f";
    const got = addNoteTask({ text: "修复文档里反馈的问题", understanding: `修复文档里反馈的问题\n\n${link}` });
    expect(got.understanding).toContain(link);
  });

  it("命中已有任务时补上原来缺的项目，已有的不覆盖", () => {
    const t = mk("导出中心分页参数没透传", "whale-console");
    const got = addNoteTask({ text: "whale-console 导出中心分页参数那条", project: "fe-wealth-admin" });
    expect(got.id).toBe(t.id);
    expect(got.project).toBe("whale-console");
  });
});
