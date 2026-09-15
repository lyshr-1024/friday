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

  it("地址取域名加一段路径，具体页面文件不算", () => {
    expect(urlPrefix("https://console.whalesit.xyz/wbo/activities?id=1")).toBe("console.whalesit.xyz/wbo");
    expect(urlPrefix("https://console.whalesit.xyz")).toBe("console.whalesit.xyz");
    expect(urlPrefix("not-a-url")).toBeUndefined();
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

  it("项目不在注册表里就什么都不写", () => {
    seed();
    expect(addProjectHints("查无此项目", { aliases: ["X"] }).changed).toBe(false);
    expect(loadProjects()).toHaveLength(2);
  });
});
