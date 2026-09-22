import { describe, expect, it } from "vitest";
import { DEFAULT_SKILL_LIST } from "@friday/shared";
import { updateSettings, userSettings } from "./settings.js";

describe("Skill 放行清单", () => {
  it("没配过时用默认精选清单，不是全放", () => {
    expect(userSettings().skillList).toEqual([...DEFAULT_SKILL_LIST]);
  });

  it("显式存 all 才全放", () => {
    expect(updateSettings({ skillList: "all" }).skillList).toBe("all");
  });

  it("存数组按数组走", () => {
    expect(updateSettings({ skillList: ["meegle", "lark-im"] }).skillList).toEqual(["meegle", "lark-im"]);
  });

  it("空数组当没配，回默认——否则等于一个 skill 都不放，Skill 模式静悄悄失效", () => {
    expect(updateSettings({ skillList: [] }).skillList).toEqual([...DEFAULT_SKILL_LIST]);
  });

  it("改清单不影响其他设置", () => {
    updateSettings({ name: "阿荣", skillList: "all" });
    const s = updateSettings({ skillList: ["meegle"] });
    expect(s.name).toBe("阿荣");
    expect(s.skills).toBe(true);
  });
});
