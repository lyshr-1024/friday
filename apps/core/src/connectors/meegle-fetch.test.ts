import { beforeEach, describe, expect, it, vi } from "vitest";

const { runJson } = vi.hoisted(() => ({ runJson: vi.fn() }));
vi.mock("./exec.js", async (orig) => ({ ...(await orig<typeof import("./exec.js")>()), runJson }));

const { MeegleConnector } = await import("./meegle.js");

// 需求现在按排期接（缺陷不看排期），所以 mock 的 story 要带一个已到期的 schedule，
// 否则在进 workitem get 之前就被筛掉了。
const todoItem = (id: number, type: string) => ({
  project_key: "pk",
  project_name: "P",
  work_item_info: { work_item_id: id, work_item_type_key: type },
  ...(type === "story" ? { schedule: { start_time: "2020-01-01", end_time: "2020-01-02" } } : {}),
});
const detail = (id: number, type: string, statusKey: string) => ({
  work_item_attribute: {
    work_item_id: String(id),
    work_item_name: `#${id}`,
    create_time: "2026-09-01T00:00:00Z",
    owned_project: { simple_name: "projectlb" },
    work_item_status: { key: statusKey, name: statusKey },
    work_item_type: { key: type, name: type },
  },
  work_item_fields: [],
});

describe("拉分派列表时过滤缺陷状态", () => {
  beforeEach(() => {
    runJson.mockReset();
  });

  it("滤掉已结束的缺陷，剩下的排期不串位", async () => {
    const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
    runJson.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === "auth") return { authenticated: true, host: "h" };
      if (args[0] === "mywork") return { list: [todoItem(1, "story"), todoItem(2, "issue"), todoItem(3, "issue"), todoItem(4, "story")], total: 4 };
      if (args[0] === "workitem") {
        const id = Number(arg(args, "--work-item-id"));
        return detail(id, id === 2 || id === 3 ? "issue" : "story", id === 2 ? "OPEN" : id === 3 ? "CLOSED" : "x");
      }
      // 只有留下来的两条 story 才该来问排期，各自给不同日期好验证对齐
      const id = Number(arg(args, "--work-item-id"));
      return { list: [{ basic: { node_key: "state_16", name: "后台前端开发", status: "not_started" }, schedule: { estimate_finish_time: id === 1 ? 1789401599999 : 1789487999999 } }] };
    });

    const items = await new MeegleConnector().fetchWorkItems();
    expect(items.map((i) => i.id)).toEqual(["1", "2", "4"]);
    expect(items.find((i) => i.id === "1")!.feDue).toBe("2026-09-14");
    expect(items.find((i) => i.id === "4")!.feDue).toBe("2026-09-15");
    expect(items.find((i) => i.id === "2")!.feDue).toBeUndefined();
  });

  it("按类型拉各自要的字段：缺陷要描述，需求要三份资料链接", async () => {
    const fieldsFor = new Map<number, string>();
    runJson.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === "auth") return { authenticated: true, host: "h" };
      if (args[0] === "mywork") return { list: [todoItem(1, "story"), todoItem(2, "issue")], total: 2 };
      if (args[0] === "workitem") {
        const id = Number(args[args.indexOf("--work-item-id") + 1]);
        fieldsFor.set(id, args[args.indexOf("--fields") + 1]!);
        return detail(id, id === 2 ? "issue" : "story", id === 2 ? "OPEN" : "x");
      }
      return { list: [] };
    });

    await new MeegleConnector().fetchWorkItems();
    expect(fieldsFor.get(1)).toBe("priority,tags,description,field_8fe714,field_8190c7,field_1f7126");
    expect(fieldsFor.get(2)).toBe("priority,tags,description,_field_linked_story");
  });
});
