import { describe, expect, it } from "vitest";
import { keepWorkItem, nodeKeyOf, pickDocs, pickLinkedStory, pickNodeSchedules, pickTransitions, toTodo } from "./meegle.js";

describe("Meegle 工作项转待办", () => {
  it("拼出标签、状态与详情链接", () => {
    const todo = toTodo("project.larksuite.com", {
      work_item_attribute: {
        work_item_id: "24354768",
        work_item_name: "  报表刷新按钮没有请求 query  ",
        create_time: "2026-08-27T09:40:50Z",
        owned_project: { simple_name: "projectlb" },
        work_item_status: { name: "Open" },
        work_item_type: { key: "issue", name: "Defect" },
      },
      work_item_fields: [{ key: "priority", value: { label: "P1", value: "1" } }],
    });
    expect(todo).toEqual({
      id: "meegle:24354768",
      text: "[P1 · Defect] 报表刷新按钮没有请求 query（Open）",
      source: "meegle",
      sourceUrl: "https://project.larksuite.com/projectlb/issue/detail/24354768",
      createdAt: "2026-08-27T09:40:50Z",
      done: false,
    });
  });
});

describe("从工作流节点里挑排期", () => {
  const node = (node_key: string, name: string, start: number | null, finish: number | null, status = "not_started") => ({
    basic: { node_key, name, status },
    schedule: { estimate_start_time: start, estimate_finish_time: finish },
  });
  // 2026-09-14 23:59:59.999 与 2026-09-15 23:59:59.999（东八区）
  const be = 1789401599999;
  const fe = 1789487999999;

  it("按 node_key 认出后台前端与服务端开发节点", () => {
    expect(
      pickNodeSchedules([node("state_15", "服务端开发", null, be), node("state_16", "后台前端开发", null, fe), node("state_5", "技术方案确认", null, null)]),
    ).toEqual({ feDue: "2026-09-15", beDue: "2026-09-14" });
  });

  it("node_key 对不上时按节点英文名兜底", () => {
    expect(
      pickNodeSchedules([node("x_9", "Server Development", null, be), node("x_8", "Admin Frontend Development", null, fe)]),
    ).toEqual({ feDue: "2026-09-15", beDue: "2026-09-14" });
  });

  it("节点已经做完就不算排期，免得早已交付的工单顶在队首", () => {
    expect(pickNodeSchedules([node("state_16", "后台前端开发", null, fe, "finished"), node("state_15", "服务端开发", null, be, "finished")])).toEqual({});
    expect(pickNodeSchedules([node("state_16", "后台前端开发", null, fe, "finished"), node("state_15", "服务端开发", null, be, "doing")])).toEqual({ beDue: "2026-09-14" });
  });

  it("没排期的节点不产出字段", () => {
    expect(pickNodeSchedules([node("state_16", "后台前端开发", null, null), node("state_15", "服务端开发", null, be)])).toEqual({ beDue: "2026-09-14" });
    expect(pickNodeSchedules([])).toEqual({});
  });
});

describe("缺陷只留还要修的", () => {
  it("Open / Reopened / In Development 留下，已结束的滤掉", () => {
    expect(keepWorkItem("issue", "OPEN")).toBe(true);
    expect(keepWorkItem("issue", "REOPENED")).toBe(true);
    expect(keepWorkItem("issue", "IN PROGRESS")).toBe(true);
    expect(keepWorkItem("issue", "TPivPPL9-")).toBe(false); // WON'T FIX
    expect(keepWorkItem("issue", "RESOLVED")).toBe(false);
    expect(keepWorkItem("issue", "CLOSED")).toBe(false);
  });

  it("需求不受状态过滤，节点流转自有去处", () => {
    expect(keepWorkItem("story", "0PVM21sG5")).toBe(true);
    expect(keepWorkItem("story", "whatever")).toBe(true);
  });
});

describe("挑出能在 Friday 里做的状态流转", () => {
  const tr = (id: number, state_key: string, state_name: string, confirm_form: unknown = null) => ({ id, state_key, state_name, confirm_form });

  it("白名单内的给中文文案，按白名单顺序排", () => {
    expect(
      pickTransitions([tr(1062797, "TPivPPL9-", "WON'T FIX"), tr(1062795, "IN PROGRESS", "In Development"), tr(9, "RESOLVED", "Resolved")]),
    ).toEqual([
      { id: "1062795", stateKey: "IN PROGRESS", label: "开始处理" },
      { id: "9", stateKey: "RESOLVED", label: "修完了" },
    ]);
  });

  it("要填表单的不做，交给 Meegle 网页", () => {
    expect(pickTransitions([tr(1, "IN PROGRESS", "In Development", { fields: [] })])).toEqual([]);
  });

  it("白名单外的一律不出按钮", () => {
    expect(pickTransitions([tr(1, "MG7yKUvQE", "Legacy issue"), tr(2, "CLOSED", "Closed")])).toEqual([]);
  });
});

describe("需求的节点与资料链接", () => {
  it("从 node_state_key 反解出流转要用的 node_key", () => {
    expect(nodeKeyOf("node_state_16_24333723", 24333723)).toBe("state_16");
    expect(nodeKeyOf("node_doing_24098811", 24098811)).toBe("doing");
    expect(nodeKeyOf("", 1)).toBeUndefined();
    expect(nodeKeyOf("乱七八糟", 1)).toBeUndefined();
  });

  it("按字段 key 认出三份资料，没填的不产出", () => {
    expect(
      pickDocs([
        { key: "field_8fe714", name: "Requirement doc URL", value: "https://a/req" },
        { key: "field_8190c7", name: "Technical doc URL", value: "https://a/tech" },
        { key: "priority", name: "Priority", value: { label: "P0" } },
      ]),
    ).toEqual({ req: "https://a/req", tech: "https://a/tech" });
    expect(pickDocs([])).toEqual({});
  });

  it("字段 key 换了就按字段名兜底", () => {
    expect(pickDocs([{ key: "field_xxxxxx", name: "Design URL", value: "https://a/ui" }])).toEqual({ design: "https://a/ui" });
  });

  it("空串和非字符串当没填", () => {
    expect(pickDocs([{ key: "field_8fe714", name: "Requirement doc URL", value: "   " }, { key: "field_1f7126", name: "Design URL", value: { rich: 1 } }])).toEqual({});
  });
});

describe("关联需求", () => {
  it("按 key 取，中英文字段名兜底", () => {
    expect(pickLinkedStory([{ key: "_field_linked_story", value: { id: 24212172, name: "【裂变】邀请达标不发奖" } }])).toEqual({
      id: "24212172",
      name: "【裂变】邀请达标不发奖",
    });
    // key 变了但名字对得上
    expect(pickLinkedStory([{ key: "other", name: "关联需求", value: { id: 1, name: "x" } }])).toEqual({ id: "1", name: "x" });
    expect(pickLinkedStory([{ key: "other", name: "Linked Requirement", value: { id: 2, name: "y" } }])).toEqual({ id: "2", name: "y" });
  });

  it("没填、只有一半、类型不对都当没有", () => {
    expect(pickLinkedStory([])).toBeUndefined();
    expect(pickLinkedStory([{ key: "_field_linked_story", value: null }])).toBeUndefined();
    expect(pickLinkedStory([{ key: "_field_linked_story", value: { id: 1 } }])).toBeUndefined();
    expect(pickLinkedStory([{ key: "_field_linked_story", value: { name: "只有名字" } }])).toBeUndefined();
  });
});
