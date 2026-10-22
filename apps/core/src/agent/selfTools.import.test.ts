import { saidLast } from "./selfTools.js";
import { describe, expect, it } from "vitest";

describe("selfTools 单独加载", () => {
  it("先 import selfTools 不会撞循环导入", () => {
    expect(typeof saidLast).toBe("function");
  });
});
