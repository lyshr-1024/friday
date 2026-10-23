import { describe, expect, it } from "vitest";
import { idFromUrl, idsIn, kindOf, ownsHost, parseRef, stateOf } from "./rules.js";

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
    expect(parseRef("https://project.larksuite.com/projectlb/story/detail/24487610")).toEqual({ space: "projectlb", id: "24487610" });
    expect(parseRef("24487610")).toBeUndefined();
  });

  it("工单号与自家域名", () => {
    expect(idFromUrl("https://project.feishu.cn/xx/issue/detail/1234")).toBe("1234");
    expect(idsIn("看下 https://project.feishu.cn/whale/story/detail/2444053")).toEqual(["2444053"]);
    expect(ownsHost("project.feishu.cn")).toBe(true);
    expect(ownsHost("console.longbridge.xyz")).toBe(false);
  });
});
