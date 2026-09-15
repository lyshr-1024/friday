import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addProjectHints, hintsFrom, titleTags, urlPrefix } from "./projectHints.js";
import { loadProjects } from "./projects.js";
import { initMemory } from "./db.js";

const seed = () => {
  const dir = process.env.FRIDAY_DATA_DIR!;
  initMemory(dir);
  writeFileSync(join(dir, "projects.md"), "# 项目注册表\n\n## whale-console\n- 目录：~/w\n- 别名：后台\n\n## other\n- 目录：~/o\n");
  return dir;
};

describe("从工单里提线索", () => {
  it("标题标记留可复用的，带流水号的丢掉", () => {
    expect(titleTags("【BO】收盘价输入错误提示待优化")).toEqual(["BO"]);
    expect(titleTags("【WBO-0907集成】【BO】任务包复制后…")).toEqual(["BO"]);
    expect(titleTags("没有标记的标题")).toEqual([]);
  });

  it("带连字符的标记同时留下主模块名，否则换一个子模块就又不认识了", () => {
    expect(titleTags("【风控-提醒查询】欠款余额对不上")).toEqual(["风控-提醒查询", "风控"]);
    expect(titleTags("【基金-私募基金净值】Fund code 搜不到")).toEqual(["基金-私募基金净值", "基金"]);
  });

  it("跨项目的泛词不沉淀，否则所有工单都会归到同一个项目", () => {
    expect(titleTags("【通用】支持批量修改")).toEqual([]);
    expect(titleTags("【业务需求】历史数据支持按时间段筛选")).toEqual([]);
    expect(titleTags("【财富需求】支持自定义链接分配")).toEqual(["财富需求"]);
  });

  it("地址取域名加一段路径，具体页面文件不算", () => {
    expect(urlPrefix("https://console.whalesit.xyz/wbo/activities?id=1")).toBe("console.whalesit.xyz/wbo");
    expect(urlPrefix("https://console.whalesit.xyz")).toBe("console.whalesit.xyz");
    expect(urlPrefix("not-a-url")).toBeUndefined();
  });

  it("工单自己在 Meegle 上的地址不算项目地址", () => {
    // 每张工单都住在 project.larksuite.com，学成项目地址后所有工单都会归到同一个仓库
    const h = hintsFrom("【BO】x", ["https://project.larksuite.com/projectlb/story/detail/1", "https://console.whalesit.xyz/wbo/a"]);
    expect(h.urls).toEqual(["console.whalesit.xyz/wbo"]);
  });

  it("hintsFrom 合起来去重", () => {
    const h = hintsFrom("【BO】x", ["https://a.com/wbo/1", "https://a.com/wbo/2"]);
    expect(h.aliases).toEqual(["BO"]);
    expect(h.urls).toEqual(["a.com/wbo"]);
  });
});

describe("线索写回 projects.md", () => {
  it("补到已有的别名行后面，新建缺失的地址行", () => {
    seed();
    const r = addProjectHints("whale-console", { aliases: ["BO"], urls: ["console.whalesit.xyz/wbo"] });
    expect(r.changed).toBe(true);
    const p = loadProjects().find((x) => x.name === "whale-console")!;
    expect(p.aliases).toEqual(["后台", "BO"]);
    expect(p.urls).toEqual(["console.whalesit.xyz/wbo"]);
    // 别的项目不受影响
    expect(loadProjects().find((x) => x.name === "other")!.aliases).toEqual([]);
  });

  it("已经有的不重复加，全都有过就不算改动", () => {
    seed();
    addProjectHints("whale-console", { aliases: ["BO"] });
    const again = addProjectHints("whale-console", { aliases: ["BO", "后台"] });
    expect(again.changed).toBe(false);
    expect(loadProjects().find((x) => x.name === "whale-console")!.aliases).toEqual(["后台", "BO"]);
  });

  it("别的项目已经占了这个别名就不学", () => {
    seed();
    addProjectHints("other", { aliases: ["BO"] });
    const r = addProjectHints("whale-console", { aliases: ["BO", "新BO"] });
    expect(r.added.aliases).toEqual(["新BO"]);
    expect(loadProjects().find((x) => x.name === "whale-console")!.aliases).toEqual(["后台", "新BO"]);
  });

  it("项目不在注册表里就什么都不写", () => {
    seed();
    expect(addProjectHints("查无此项目", { aliases: ["X"] }).changed).toBe(false);
    expect(loadProjects()).toHaveLength(2);
  });
});
