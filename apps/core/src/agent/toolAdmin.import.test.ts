import { toolAdminList } from "./toolAdmin.js";
import { describe, expect, it } from "vitest";

describe("toolAdmin 单独加载", () => {
  it("先 import toolAdmin 不会撞循环导入", () => {
    expect(typeof toolAdminList).toBe("function");
  });
});
