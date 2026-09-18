import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { allLinks, linkUp, linksOf, neighbors, rejected, unlink } from "./links.js";
import { branchNode, meegleIdsIn, meegleNode, projectNode, taskNode, urlsIn } from "./infer.js";

// 整个测试文件共用一个库，所以每个用例自己起唯一的任务 id，互不干扰
const t = () => taskNode(randomUUID());
const m = () => meegleNode(String(Math.floor(2e7 + Math.random() * 1e7)));

describe("links", () => {
  it("同一条边不管从哪头连，只存一行", () => {
    const [a, b] = [t(), m()];
    linkUp(a, b, "rule", "a");
    linkUp(b, a, "rule", "b");
    expect(linksOf(a)).toHaveLength(1);
  });

  it("可信度只升不降：user 不会被后来的 rule 覆盖", () => {
    const [a, b] = [t(), m()];
    linkUp(a, b, "user", "你指定的");
    linkUp(a, b, "rule", "分支名里有工单号");
    expect(linksOf(a)[0]!.source).toBe("user");
    expect(linksOf(a)[0]!.why).toBe("你指定的");
  });

  it("guess 会被 rule 升级", () => {
    const [a, b] = [t(), m()];
    linkUp(a, b, "guess", "模型猜的");
    linkUp(a, b, "rule", "查表查到的");
    expect(linksOf(a)[0]!.source).toBe("rule");
  });

  // 「纠正以后不能再出现问题」：否决要落盘，不能只是删一行等着被重新推断回来
  it("否决过的边，自动推断不会再连上", () => {
    const [a, b] = [t(), m()];
    linkUp(a, b, "rule", "推断的");
    unlink(a, b);
    expect(linksOf(a)).toHaveLength(0);
    expect(rejected(a, b)).toBe(true);

    linkUp(a, b, "rule", "又推断了一次");
    expect(linksOf(a)).toHaveLength(0);
  });

  it("你自己再连回来是可以的", () => {
    const [a, b] = [t(), m()];
    linkUp(a, b, "rule", "推断的");
    unlink(a, b);
    linkUp(a, b, "user", "还是这条");
    expect(linksOf(a)).toHaveLength(1);
  });

  it("否决记录不出现在查询结果里", () => {
    const [a, b] = [t(), m()];
    const before = allLinks().length;
    linkUp(a, b, "rule", "x");
    unlink(a, b);
    expect(allLinks()).toHaveLength(before);
    expect(neighbors(a, "meegle")).toHaveLength(0);
  });

  it("neighbors 只返回指定类型，user 排前面", () => {
    const a = t();
    linkUp(a, meegleNode("30000001"), "rule", "a");
    linkUp(a, meegleNode("30000002"), "user", "b");
    linkUp(a, projectNode("whale-console"), "rule", "c");
    expect(neighbors(a, "meegle").map((n) => n.ref)).toEqual(["30000002", "30000001"]);
    expect(neighbors(a, "project").map((n) => n.ref)).toEqual(["whale-console"]);
  });

  it("不同项目的同名分支不是一条边", () => {
    const a = t();
    linkUp(a, branchNode("whale-console", "main"), "rule", "a");
    linkUp(a, branchNode("fe-wealth-admin", "main"), "rule", "b");
    expect(neighbors(a, "branch").map((n) => n.ref)).toHaveLength(2);
  });

  it("自己连自己、空 ref 都不记", () => {
    const a = t();
    expect(linkUp(a, a, "rule", "x")).toBeUndefined();
    expect(linkUp(taskNode(""), m(), "rule", "x")).toBeUndefined();
    expect(linksOf(a)).toHaveLength(0);
  });
});

describe("从文本里认工单和地址", () => {
  it("认 Meegle 链接里的工单号", () => {
    expect(meegleIdsIn("https://project.larksuite.com/projectlb/issue/detail/24532474 看下")).toContain("24532474");
  });

  it("认裸的 8 位工单号", () => {
    expect(meegleIdsIn("这条是 24440539")).toContain("24440539");
  });

  it("不把短数字当工单号", () => {
    expect(meegleIdsIn("改成 16 个字符，端口 7788")).toHaveLength(0);
  });

  it("扒 URL 时去掉句末标点", () => {
    expect(urlsIn("打开 https://console.longbridge.xyz/x/menu。")).toEqual(["https://console.longbridge.xyz/x/menu"]);
  });
});
