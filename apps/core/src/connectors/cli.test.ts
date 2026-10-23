import { describe, expect, it } from "vitest";
import { fillTemplate, runCli } from "./cli.js";

describe("cli 模板", () => {
  it("把 {name} 换成参数值", () => {
    expect(fillTemplate(["workitem", "get", "--id", "{id}"], { id: 7 })).toEqual(["workitem", "get", "--id", "7"]);
  });

  it("元素里嵌着的占位符也换", () => {
    expect(fillTemplate(["--id={id}", "{a}-{b}"], { id: "x", a: 1, b: 2 })).toEqual(["--id=x", "1-2"]);
  });

  it("引用了没给的参数就抛", () => {
    expect(() => fillTemplate(["get", "{id}"], {})).toThrow("缺参数 id");
  });

  it("整个元素都是参数时，值以 - 开头就抛", () => {
    expect(() => fillTemplate(["get", "{id}"], { id: "--delete" })).toThrow("参数 id 不能以 - 开头");
    expect(fillTemplate(["--id={id}"], { id: "-1" })).toEqual(["--id=-1"]);
  });

  it("runCli 不经 shell 原样传参", async () => {
    expect((await runCli("printf", ["%s", "a b;echo x"])).trim()).toBe("a b;echo x");
  });
});
