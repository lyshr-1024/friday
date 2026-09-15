import { syncMeegleOnce as syncOnce } from "./meegle.js";
import { createTask as mkTask, getTask as readTask, updateTask as setTask } from "../memory/tasks.js";
import { state as schedState } from "../scheduler/index.js";
import { describe, expect, it } from "vitest";
import { TASK_CATEGORY_LABEL, taskCategory } from "@friday/shared";
import { extractLinks, toWorkItem } from "../connectors/meegle.js";
import { matchProjectByUrl } from "../memory/projects.js";
import { matchProject, priorityOf, workItemToTask } from "./meegle.js";

const projects = [
  { name: "whale-console", dir: "/x/whale-console", aliases: ["鲸鱼后台", "wbo"], channels: [], urls: ["console.longbridge.xyz/wbo"] },
  { name: "lb-app", dir: "/x/lb-app", aliases: ["长桥 app"], channels: [], urls: [] },
];

describe("Meegle 工单进任务中枢", () => {
  it("toWorkItem 拼出节点、优先级、链接", () => {
    const item = toWorkItem(
      "project.larksuite.com",
      { project_key: "k", project_name: "Longbridge 项目集合管理", node_info: { node_name: "FE Release" }, schedule: { end_time: "" }, work_item_info: { work_item_id: 24184714, work_item_type_key: "story" } },
      {
        work_item_attribute: {
          work_item_id: "24184714",
          work_item_name: " 【消息】消息记录内容查看权限申请与展示 ",
          create_time: "2026-08-04T08:29:33Z",
          owned_project: { simple_name: "projectlb" },
          work_item_status: { name: "Pending Release" },
          work_item_type: { key: "story", name: "Requirement" },
        },
        work_item_fields: [{ key: "priority", value: { label: "P0", value: "0" } }],
      },
    );
    expect(item).toEqual({
      id: "24184714",
      name: "【消息】消息记录内容查看权限申请与展示",
      typeName: "Requirement",
      typeKey: "story",
      links: [],
      status: "Pending Release",
      statusKey: "",
      projectKey: "k",
      priority: "P0",
      node: "FE Release",
      projectName: "Longbridge 项目集合管理",
      url: "https://project.larksuite.com/projectlb/story/detail/24184714",
      createdAt: "2026-08-04T08:29:33Z",
    });
  });

  it("优先级：P0/P1 高，P2 中，其余低", () => {
    expect(priorityOf("P0")).toBe("high");
    expect(priorityOf("P1")).toBe("high");
    expect(priorityOf("P2")).toBe("normal");
    expect(priorityOf("P3")).toBe("low");
    expect(priorityOf(undefined)).toBe("normal");
  });

  it("按标题里的项目名或别名归项目，短别名不误匹配", () => {
    expect(matchProject("wbo 报表导出时区错乱", projects)).toBe("whale-console");
    expect(matchProject("鲸鱼后台多语言字段", projects)).toBe("whale-console");
    expect(matchProject("长桥 App 首页多语言", projects)).toBe("lb-app");
    expect(matchProject("消息记录权限申请", projects)).toBeUndefined();
  });

  it("中文两个字的别名够独特，拉丁字母短词仍要三个字符", () => {
    const ps = [{ name: "whale-console", dir: "/x/w", aliases: ["风控", "bo"], channels: [], urls: [] }];
    expect(matchProject("【风控-提醒查询】欠款余额对不上", ps)).toBe("whale-console");
    expect(matchProject("bond 报表导出时区错乱", ps)).toBeUndefined();
  });

  it("工单一律先排队；理解里写清节点与状态", () => {
    const base = { id: "1", name: "wbo 导出报表时区错乱", typeName: "Defect", typeKey: "issue", status: "Open", statusKey: "OPEN", projectKey: "pk", projectName: "p", url: "u", links: [], createdAt: "2026-09-01T00:00:00Z" };
    const hot = workItemToTask({ ...base, priority: "P0", node: "FE Release" }, projects);
    expect(hot.status).toBe("understood");
    expect(hot.priority).toBe("high");
    expect(hot.project).toBe("whale-console");
    expect(hot.understanding).toBe("Meegle Defect #1，节点「FE Release」在等你，状态 Open，优先级 P0");
    const cold = workItemToTask({ ...base, priority: "P2", due: "2026-09-10T00:00:00Z" }, projects);
    expect(cold.status).toBe("understood");
    expect(cold.due).toBe("2026-09-10T00:00:00Z");
    expect(cold.understanding).toContain("截止 2026-09-10");
  });
});

describe("Meegle 同步：Reopen 的工单拉回待办", () => {
  const item = (id: string, status: string) => ({ id, name: `缺陷 ${id}`, typeName: "Defect", typeKey: "issue", links: [], status, projectName: "demo", url: `https://x/${id}`, createdAt: "2026-09-01T00:00:00Z" });
  const fake = (items: ReturnType<typeof item>[]) => ({ fetchWorkItems: async () => items }) as never;

  it("Friday 里已完成、Meegle 里 Reopened 且又在分派列表 → 回到待办、记账、通知", async () => {
    const t = mkTask({ title: "缺陷 r1", kind: "meegle", source: { meegleId: "r1", url: "https://x/r1" }, status: "done" });
    const r = await syncOnce(fake([item("r1", "Reopened")]));
    expect(r.reopened).toBe(1);
    expect(readTask(t.id)!.status).toBe("understood");
    expect(schedState.notices.some((n) => n.title.includes("Reopen"))).toBe(true);
  });

  it("Friday 里主动标完成、Meegle 状态不是 Reopen → 不动，免得每 15 分钟翻回来", async () => {
    const t = mkTask({ title: "缺陷 r2", kind: "meegle", source: { meegleId: "r2", url: "https://x/r2" }, status: "done" });
    setTask(t.id, { status: "done" });
    const r = await syncOnce(fake([item("r2", "In Progress")]));
    expect(r.reopened).toBe(0);
    expect(readTask(t.id)!.status).toBe("done");
  });
});

describe("需求与缺陷分组", () => {
  it("story 归需求，issue 归缺陷，自定义类型和没有类型的归其他", () => {
    expect(taskCategory({ meegleType: "story" })).toBe("story");
    expect(taskCategory({ meegleType: "issue" })).toBe("defect");
    expect(taskCategory({ meegleType: "6a0d931f3129fdef6aba3188" })).toBe("other");
    expect(taskCategory({})).toBe("other");
    expect(TASK_CATEGORY_LABEL[taskCategory({ meegleType: "story" })]).toBe("需求");
  });

  it("Slack 线程单独一类，看 threadId 认，它没有 meegleType", () => {
    expect(taskCategory({ threadId: "th-1" })).toBe("slack");
    expect(TASK_CATEGORY_LABEL[taskCategory({ threadId: "th-1" })]).toBe("Slack");
    // Meegle 工单不会有 threadId，不受影响
    expect(taskCategory({ meegleType: "issue" })).toBe("defect");
  });
});

describe("排期与标签进任务", () => {
  const raw = (fields: Array<{ key: string; value: unknown }>, typeKey = "story", typeName = "Requirement") => ({
    work_item_attribute: {
      work_item_id: "24353876",
      work_item_name: "【通用】后台优化需求汇总",
      create_time: "2026-08-27T08:46:42Z",
      owned_project: { simple_name: "projectlb" },
      work_item_status: { name: "In Technical Solution Confirmation" },
      work_item_type: { key: typeKey, name: typeName },
    },
    work_item_fields: fields,
  });
  const todo = { project_key: "k", work_item_info: { work_item_id: 24353876, work_item_type_key: "story" } };

  it("toWorkItem 带出类型、标签与两个节点的排期", () => {
    const item = toWorkItem(
      "project.larksuite.com",
      todo,
      raw([
        { key: "priority", value: { label: "P0", value: "0" } },
        { key: "tags", value: [{ label: "Backend Iteration", value: "545fg1y2o" }] },
      ]),
      { feDue: "2026-09-15", beDue: "2026-09-14" },
    );
    expect(item.typeKey).toBe("story");
    expect(item.tags).toEqual(["Backend Iteration"]);
    expect(item.feDue).toBe("2026-09-15");
    expect(item.beDue).toBe("2026-09-14");
  });

  it("缺陷类型认成 issue，没有标签时不产出字段", () => {
    const item = toWorkItem("h", todo, raw([], "issue", "Defect"), {});
    expect(item.typeKey).toBe("issue");
    expect(item.tags).toBeUndefined();
    expect(item.feDue).toBeUndefined();
  });

  it("workItemToTask 把它们写进 source，排期没了要能清空", () => {
    const base = { id: "1", name: "后台优化", typeName: "Requirement", typeKey: "story", status: "Open", statusKey: "s", projectName: "p", projectKey: "pk", links: [], url: "u", createdAt: "2026-09-01T00:00:00Z" };
    const t = workItemToTask({ ...base, tags: ["Backend Iteration"], feDue: "2026-09-15" }, []);
    expect(t.source).toMatchObject({ meegleType: "story", meegleTags: ["Backend Iteration"], feDue: "2026-09-15", beDue: undefined, meegleProject: "pk" });
    expect(t.understanding).toContain("后台前端排期 2026-09-15");

    const cleared = workItemToTask(base, []);
    expect(cleared.source).toMatchObject({ meegleType: "story", meegleTags: undefined, feDue: undefined, beDue: undefined });
  });

  it("只有服务端排期时理解里写服务端", () => {
    const t = workItemToTask({ id: "1", name: "x", typeName: "Requirement", typeKey: "story", status: "Open", statusKey: "s", projectName: "p", projectKey: "pk", links: [], url: "u", createdAt: "2026-09-01T00:00:00Z", beDue: "2026-09-20" }, []);
    expect(t.understanding).toContain("服务端排期 2026-09-20");
  });
});

describe("缺陷详情进任务", () => {
  const issue = (extra: Record<string, unknown> = {}, fields: Array<{ key: string; value: unknown }> = []) => ({
    work_item_attribute: {
      work_item_id: "24420780",
      work_item_name: "【基金-私募基金净值】Fund code 远程搜索候选永远为空",
      create_time: "2026-09-05T02:00:00Z",
      create_by: { name: "木木 (Lin Biwang)", email: "biwang.lin@longbridge-inc.com" },
      owned_project: { simple_name: "projectlb" },
      work_item_status: { key: "REOPENED", name: "Reopened" },
      work_item_type: { key: "issue", name: "Defect" },
      ...extra,
    },
    work_item_fields: fields,
  });
  const todo = { project_key: "6a140fc96061a9dd2771b320", work_item_info: { work_item_id: 24420780, work_item_type_key: "issue" } };

  it("带出描述、提出人、状态 key 与空间，供详情和流转用", () => {
    const item = toWorkItem("project.larksuite.com", todo, issue({}, [{ key: "description", value: "**现象**:候选数全部为 0" }]));
    expect(item.statusKey).toBe("REOPENED");
    expect(item.projectKey).toBe("6a140fc96061a9dd2771b320");
    expect(item.description).toBe("**现象**:候选数全部为 0");
    expect(item.reporter).toBe("木木 (Lin Biwang)");
  });

  it("提出人优先取 Reporter 角色，没有才回退创建人", () => {
    const withRole = issue({ role_members: [{ name: "Reporter", members: [{ name: "馨怡 (Yu Junrong)", email: "junrong.yu@longbridge-inc.com" }] }] });
    expect(toWorkItem("h", todo, withRole).reporter).toBe("馨怡 (Yu Junrong)");
  });

  it("缺陷的描述、提出人写进 source，需求不带描述免得塞进几十 KB 需求文档", () => {
    const t = workItemToTask(
      { id: "1", name: "x", typeName: "Defect", typeKey: "issue", statusKey: "REOPENED", status: "Reopened", projectName: "p", projectKey: "pk", links: [], url: "u", createdAt: "2026-09-01T00:00:00Z", reporter: "木木", description: "**现象**:空" },
      [],
    );
    expect(t.source.reporter).toBe("木木");
    expect(t.source.description).toBe("**现象**:空");
    expect(t.source.meegleProject).toBe("pk");
    expect(t.source.statusKey).toBe("REOPENED");
  });
});

describe("需求的资料链接与当前节点", () => {
  const story = (fields: Array<{ key: string; name?: string; value: unknown }>) => ({
    work_item_attribute: {
      work_item_id: "24333723",
      work_item_name: "【LBNZ】客户资料新增人脸照片上传栏位",
      create_time: "2026-09-01T00:00:00Z",
      owned_project: { simple_name: "projectlb" },
      work_item_status: { key: "s", name: "In Development" },
      work_item_type: { key: "story", name: "Requirement" },
    },
    work_item_fields: fields,
  });
  const todo = {
    project_key: "pk",
    node_info: { node_name: "Admin Frontend Development", node_state_key: "node_state_16_24333723" },
    work_item_info: { work_item_id: 24333723, work_item_type_key: "story" },
  };

  it("带出资料链接与流转要用的 node_key", () => {
    const item = toWorkItem("h", todo, story([{ key: "field_8fe714", name: "Requirement doc URL", value: "https://a/req" }]));
    expect(item.docs).toEqual({ req: "https://a/req" });
    expect(item.nodeKey).toBe("state_16");
  });

  it("三份资料都写进 source，没填的键不出现", () => {
    const t = workItemToTask(
      { id: "1", name: "x", typeName: "Requirement", typeKey: "story", statusKey: "s", status: "In Development", projectName: "p", projectKey: "pk", links: [], url: "u", createdAt: "2026-09-01T00:00:00Z", nodeKey: "state_16", docs: { req: "https://a/req", tech: "https://a/tech" } },
      [],
    );
    expect(t.source.docs).toEqual({ req: "https://a/req", tech: "https://a/tech" });
    expect(t.source.nodeKey).toBe("state_16");
  });
});

describe("按页面链接归项目", () => {
  it("描述里的链接比标题可靠：标题只写「BO 后台」也能归到 whale-console", () => {
    const base = { id: "2", name: "【BO 后台】任务类型下拉框缺少「日内融平仓」", typeName: "Defect", typeKey: "issue", status: "Open", projectName: "p", statusKey: "OPEN", projectKey: "pk", url: "u", createdAt: "2026-09-01T00:00:00Z" };
    expect(workItemToTask({ ...base, links: [] }, projects).project).toBeUndefined();
    const located = workItemToTask({ ...base, links: ["https://console.longbridge.xyz/wbo/risk/auto-close-settings?page=1"] }, projects);
    expect(located.project).toBe("whale-console");
    expect(located.understanding).toContain("出问题的页面：https://console.longbridge.xyz/wbo/risk/auto-close-settings");
  });

  it("链接归不到项目时回落到标题匹配", () => {
    const base = { id: "3", name: "鲸鱼后台导出报表时区错乱", typeName: "Defect", typeKey: "issue", status: "Open", projectName: "p", statusKey: "OPEN", projectKey: "pk", url: "u", createdAt: "2026-09-01T00:00:00Z" };
    expect(workItemToTask({ ...base, links: ["https://unknown.example.com/x"] }, projects).project).toBe("whale-console");
  });
});

describe("extractLinks", () => {
  it("挑出产品链接，排掉 Meegle / 飞书自己的，去重并截断尾随标点", () => {
    const desc = "【测试环境】lb staging\n[https://console.longbridge.xyz/wbo/risk/x](https://console.longbridge.xyz/wbo/risk/x)\n工单 https://project.larksuite.com/projectlb/issue/detail/1 见 https://console.longbridge.xyz/wbo/risk/x。";
    expect(extractLinks(desc)).toEqual(["https://console.longbridge.xyz/wbo/risk/x"]);
    expect(extractLinks(undefined)).toEqual([]);
  });

  it("走查模板只写站内路径时也算线索，完整链接仍排在前面", () => {
    expect(extractLinks("**操作入口**：`/x/wbo/fund/private-funds/nav` → 工具栏「Add NAV」")).toEqual(["/x/wbo/fund/private-funds/nav"]);
    expect(extractLinks("见 https://console.longbridge.xyz/wbo/risk/x，入口 `/x/wbo/risk/config`")).toEqual([
      "https://console.longbridge.xyz/wbo/risk/x",
      "/x/wbo/risk/config",
    ]);
    expect(extractLinks("跑 `pnpm dev` 就行，`/a` 太短")).toEqual([]);
  });
});

describe("matchProjectByUrl", () => {
  const ps = [
    { name: "老后台", dir: "/o", aliases: [], channels: [], urls: ["console.longbridge.xyz"] },
    { name: "新后台", dir: "/n", aliases: [], channels: [], urls: ["console.longbridge.xyz/wbo"] },
  ];
  it("前缀更长的赢：迁移期同域名下新旧并存", () => {
    expect(matchProjectByUrl(["https://console.longbridge.xyz/wbo/risk/x"], ps)?.name).toBe("新后台");
    expect(matchProjectByUrl(["https://console.longbridge.xyz/other/y"], ps)?.name).toBe("老后台");
  });
  it("前缀必须落在路径边界上，不做半个段的匹配", () => {
    expect(matchProjectByUrl(["https://console.longbridge.xyz/wbotest/x"], ps)?.name).toBe("老后台");
    expect(matchProjectByUrl(["https://other.example.com/wbo"], ps)).toBeUndefined();
    expect(matchProjectByUrl([], ps)).toBeUndefined();
  });
});
