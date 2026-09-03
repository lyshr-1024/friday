import { describe, expect, it } from "vitest";
import { toTodo } from "./meegle.js";

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
