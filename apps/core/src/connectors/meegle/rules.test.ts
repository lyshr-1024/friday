import { describe, expect, it } from "vitest";
import { addressable, external, idFromUrl, idsIn, kindOf, node, ownsHost, parentRef, parseRef, spaceRef, stateOf } from "./rules.js";

describe("Meegle 规则", () => {
  it("终态按 key 或名称认，随机码的 WON'T FIX 和 systemEnded 都算", () => {
    expect(stateOf("TPivPPL9-", "WON'T FIX")).toBe("done");
    expect(stateOf("systemEnded")).toBe("done");
    expect(stateOf("RESOLVED", "Resolved")).toBe("done");
    expect(stateOf("x", "已关闭")).toBe("done");
  });

  it("测试中、Reopen、开始处理、其余", () => {
    expect(stateOf("x", "In Testing")).toBe("testing");
    expect(stateOf("REOPENED", "Reopened")).toBe("reopened");
    expect(stateOf("IN PROGRESS", "In Development")).toBe("in_progress");
    expect(stateOf("OPEN", "Open")).toBe("open");
    expect(stateOf("MG7yKUvQE", "Legacy issue")).toBe("open");
  });

  it("类型：story 是需求，issue / defect / bug 是缺陷，其余 other", () => {
    expect(kindOf("story")).toBe("story");
    expect(kindOf("issue")).toBe("defect");
    expect(kindOf("bug")).toBe("defect");
    expect(kindOf("6a0d931f3129fdef6aba3188")).toBe("other");
    expect(kindOf(undefined)).toBe("other");
  });

  it("从链接里拆出空间和工单号，光给数字不行", () => {
    expect(parseRef("https://project.larksuite.com/projectlb/story/detail/24487610")).toEqual({ tool: "meegle", type: "work_item", id: "24487610", attrs: { space: "projectlb" } });
    expect(parseRef("24487610")).toBeUndefined();
  });

  it("工单号与自家域名", () => {
    expect(idFromUrl("https://project.feishu.cn/xx/issue/detail/1234")).toBe("1234");
    expect(idsIn("看下 https://project.feishu.cn/whale/story/detail/2444053")).toEqual(["2444053"]);
    expect(ownsHost("project.feishu.cn")).toBe(true);
    expect(ownsHost("console.longbridge.xyz")).toBe(false);
  });

  describe("工单 → 卡上的引用", () => {
    const item = { id: "24420780", name: "缺陷", typeName: "Defect", typeKey: "issue", links: [], status: "Reopened", statusKey: "REOPENED", projectName: "p", projectKey: "pk", url: "u", createdAt: "2026-09-01T00:00:00Z" };

    it("核心字段给业务读，空间 / 类型键 / 节点 / 报告人进 attrs", () => {
      const ext = external({ ...item, linkedStory: { id: "s1", name: "需求" }, feDue: "2026-09-15", tags: ["Backend Iteration"], nodeKey: "state_16", node: "前端开发", reporter: "木木" });
      expect(ext).toEqual({
        tool: "meegle",
        type: "work_item",
        id: "24420780",
        kind: "defect",
        state: { key: "REOPENED" },
        parent: { id: "s1", name: "需求" },
        schedule: { frontend: "2026-09-15" },
        tags: ["Backend Iteration"],
        attrs: { typeKey: "issue", space: "pk", nodeKey: "state_16", nodeName: "前端开发", reporter: "木木" },
      });
    });

    it("没有的字段不出现：没排期没标签没节点，状态 key 为空也不写", () => {
      expect(external({ ...item, statusKey: "" })).toEqual({ tool: "meegle", type: "work_item", id: "24420780", kind: "defect", attrs: { typeKey: "issue", space: "pk" } });
    });

    it("所属需求跟着缺陷的空间走；没挂需求或没记空间就没有", () => {
      const ext = external({ ...item, linkedStory: { id: "s1", name: "需求" } });
      expect(parentRef(ext)).toEqual({ tool: "meegle", type: "work_item", id: "s1", attrs: { space: "pk" } });
      expect(parentRef(external(item))).toBeUndefined();
      expect(parentRef({ tool: "meegle", type: "work_item", id: "1", parent: { id: "s1" } })).toBeUndefined();
    });

    it("老卡没记空间：查不了，节点类操作也拿不到", () => {
      const bare = { tool: "meegle", type: "work_item" as const, id: "1", attrs: { nodeKey: "state_16" } };
      expect(addressable(bare)).toBe(false);
      expect(() => spaceRef(bare)).toThrow("没有 Meegle 工单信息");
      expect(addressable(external(item))).toBe(true);
      expect(spaceRef(external(item))).toEqual({ space: "pk", id: "24420780" });
      expect(node(bare)).toEqual({ key: "state_16" });
      expect(node({ ...bare, attrs: { nodeName: "前端开发" } })).toEqual({ name: "前端开发" });
      expect(node(external(item))).toBeUndefined();
      expect(node({ ...bare, tool: "slack" })).toBeUndefined();
    });
  });
});
