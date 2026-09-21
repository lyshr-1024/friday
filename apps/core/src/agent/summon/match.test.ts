import { describe, expect, it } from "vitest";
import type { Snapshot, Task } from "@friday/shared";
import type { Project } from "../../memory/projects.js";
import { buildRules, candidates, defaultActions, meegleIdFromUrl, parseSlackTitle, projectByCwd } from "./match.js";

const projects: Project[] = [
  { name: "whale-console", dir: "/Users/me/work/whale-console", aliases: ["鲸鱼后台"], channels: ["#wealth-fe"], urls: [] },
  { name: "fe-wealth-admin", dir: "/Users/me/work/fe-wealth-admin", aliases: [], channels: [], urls: [] },
];

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "提现规则 tab 错位",
    kind: "meegle",
    source: { meegleId: "1234" },
    project: "whale-console",
    status: "understood",
    priority: "normal",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: Date.now(),
    app: { bundleId: "com.google.Chrome", name: "Chrome", title: "Meegle" },
    permissions: { accessibility: true, automation: true, screen: true },
    ...over,
  };
}

describe("parseSlackTitle", () => {
  it("从窗口标题里取频道", () => {
    expect(parseSlackTitle("#wealth-fe (3 new items) - Longbridge - Slack")).toEqual({ channel: "#wealth-fe" });
  });

  it("私聊标题取人名", () => {
    expect(parseSlackTitle("拂晓 - Longbridge - Slack")).toEqual({ person: "拂晓" });
  });

  // 中文界面的真实标题：不带 #，跟一个全角「（频道）」后缀。按 # 判断会把它当成人名
  it("中文界面的频道标题（不带 # 带「（频道）」后缀）", () => {
    expect(parseSlackTitle("team-fe-bo（频道） - Longbridge - Slack")).toEqual({ channel: "team-fe-bo" });
    // 有未读时中间会多插一段，「（频道）」不在结尾了——不能按结尾匹配
    expect(parseSlackTitle("一起养牛（频道） - Longbridge - 1 个新项目 - Slack")).toEqual({ channel: "一起养牛" });
  });

  it("按需求建的 proj- 频道", () => {
    expect(parseSlackTitle("proj-推荐feed页迭代与实验多组分流能力（频道） - Longbridge - Slack")).toEqual({
      channel: "proj-推荐feed页迭代与实验多组分流能力",
    });
  });

  // 左侧那些视图会整个占掉标题，认成人名只会让 Friday 去找一个叫「活动」的同事
  it("视图名不当成人名", () => {
    expect(parseSlackTitle("活动 - Longbridge - Slack")).toEqual({});
    expect(parseSlackTitle("私信 - Longbridge - Slack")).toEqual({});
  });

  it("私聊未读徽标是纯数字也取人名", () => {
    expect(parseSlackTitle("拂晓 (2) - Longbridge - Slack")).toEqual({ person: "拂晓" });
  });

  it("频道未读徽标是纯数字也取频道", () => {
    expect(parseSlackTitle("#wealth-fe (12) - Longbridge - Slack")).toEqual({ channel: "#wealth-fe" });
  });
});

describe("meegleIdFromUrl", () => {
  it("认出工单 id", () => {
    expect(meegleIdFromUrl("https://project.feishu.cn/xx/issue/detail/1234")).toBe("1234");
  });

  it("不是工单页返回 undefined", () => {
    expect(meegleIdFromUrl("https://project.feishu.cn/xx/dashboard")).toBeUndefined();
  });
});

describe("projectByCwd", () => {
  it("按目录前缀命中，取最深的", () => {
    expect(projectByCwd("/Users/me/work/whale-console/apps/web", projects)?.name).toBe("whale-console");
  });

  it("不在任何项目下返回 undefined", () => {
    expect(projectByCwd("/tmp", projects)).toBeUndefined();
  });
});

describe("candidates", () => {
  it("URL 里的工单 id 精确命中算 sure", () => {
    const got = candidates({
      snapshot: snap({ browser: { url: "https://project.feishu.cn/x/issue/detail/1234", title: "提现规则" } }),
      tasks: [task()],
      projects,
    });
    expect(got).toHaveLength(1);
    expect(got[0]!.strength).toBe("sure");
  });

  it("频道命中项目下的任务算 maybe", () => {
    const got = candidates({ snapshot: snap(), tasks: [task({ status: "processing" })], projects, channel: "#wealth-fe" });
    expect(got[0]!.strength).toBe("maybe");
  });

  it("选中文字带 # 前缀的工单号才算 sure", () => {
    const got = candidates({ snapshot: snap({ selection: "这个 #1234 帮我看下" }), tasks: [task()], projects });
    expect(got[0]?.strength).toBe("sure");
  });

  it("裸数字不匹配工单——年份金额行号都是四位数，撞上就会把无关任务送上按钮", () => {
    const got = candidates({ snapshot: snap({ selection: "2024 年的预算是 1234 万" }), tasks: [task()], projects });
    expect(got).toEqual([]);
  });

  // 真机踩过：开着 whale-console 的调试页按热键，URL 不是工单页于是一个候选都没有，
  // HUD 只好另起一个终端——而那个项目明明正有终端在跑
  it("开着某个项目的页面，该项目在办的任务就是候选，终端在跑的排最前", () => {
    const withUrl: Project[] = [{ ...projects[0]!, urls: ["console.longbridge.xyz/x"] }, projects[1]!];
    const running = task({ id: "t-run", title: "后台项目的反馈问题处理", status: "processing", source: { jobId: "j1" } });
    const idle = task({ id: "t-idle", title: "别的活", status: "understood", source: {} });
    const got = candidates({
      snapshot: snap({ browser: { url: "https://console.longbridge.xyz/x/wbo/funds", title: "加密货币" } }),
      tasks: [idle, running],
      projects: withUrl,
    });
    expect(got.map((c) => c.task.id)).toEqual(["t-run", "t-idle"]);
    expect(got[0]!.why).toContain("正在终端里跑");
  });

  it("什么都对不上返回空", () => {
    const got = candidates({ snapshot: snap(), tasks: [task()], projects });
    expect(got).toEqual([]);
  });
});

describe("defaultActions", () => {
  it("有待审动作时第一个是通过并执行", () => {
    const t = task({ status: "review", pending: [{ id: "a1", type: "slack_reply", label: "回复拂晓", detail: "草稿", payload: {} }] });
    const [first] = defaultActions(t, undefined, snap());
    expect(first).toMatchObject({ kind: "approve_pending", taskId: "t1", actionId: "a1" });
  });

  it("understood 的任务给开工", () => {
    const [first] = defaultActions(task(), projects[0], snap());
    expect(first!.kind).toBe("start_work");
  });

  it("没对上任务时给建成任务", () => {
    const [first] = defaultActions(undefined, undefined, snap({ selection: "帮我把导出中心加个筛选" }));
    expect(first!.kind).toBe("create_task");
  });
});

describe("buildRules", () => {
  it("Slack 私聊只显示人名，不带未读数字和后缀", () => {
    const rules = buildRules({
      snapshot: snap({ app: { bundleId: "com.tinyspeck.slackmacgap", name: "Slack", title: "拂晓 (2) - Longbridge - Slack" } }),
      tasks: [],
      projects,
    });
    expect(rules.saw).toBe("Slack · 拂晓");
  });

  it("模型永远跑：有选中文字时 willThink 为 true", () => {
    const rules = buildRules({ snapshot: snap({ selection: "这段报错" }), tasks: [], projects });
    expect(rules.willThink).toBe(true);
  });

  it("只有 URL 没有文字也照样调模型——那正是最需要它动脑的时候", () => {
    const rules = buildRules({
      snapshot: snap({ browser: { url: "https://project.feishu.cn/x/issue/detail/1234", title: "" } }),
      tasks: [task()],
      projects,
    });
    expect(rules.willThink).toBe(true);
    expect(rules.match?.taskId).toBe("t1");
  });

  it("saw 里写清看到的是什么", () => {
    const rules = buildRules({ snapshot: snap({ browser: { url: "https://project.feishu.cn/x/issue/detail/1234", title: "提现规则" } }), tasks: [], projects });
    expect(rules.saw).toContain("Chrome");
  });
});
