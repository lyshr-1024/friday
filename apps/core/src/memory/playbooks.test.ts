import { describe, expect, it } from "vitest";
import { readPlaybook, writePlaybook } from "./playbooks.js";

describe("playbook 文件", () => {
  it("没写过时是空串，写了能读回", () => {
    expect(readPlaybook("question")).toBe("");
    writePlaybook("question", "# question\n## 怎么回\n- 先看工单状态\n");
    expect(readPlaybook("question")).toContain("先看工单状态");
  });
});
