import { describe, expect, it } from "vitest";
import { toWorkItem } from "../connectors/meegle.js";
import { matchProject, priorityOf, workItemToTask } from "./meegle.js";

const projects = [
  { name: "whale-console", dir: "/x/whale-console", aliases: ["鲸鱼后台", "wbo"], channels: [] },
  { name: "lb-app", dir: "/x/lb-app", aliases: ["长桥 app"], channels: [] },
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
      status: "Pending Release",
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

  it("工单一律先排队；理解里写清节点与状态", () => {
    const base = { id: "1", name: "wbo 导出报表时区错乱", typeName: "Defect", status: "Open", projectName: "p", url: "u", createdAt: "2026-09-01T00:00:00Z" };
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
