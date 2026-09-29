import { describe, expect, it } from "vitest";
import { DEFAULT_SKILL_LIST } from "@friday/shared";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
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

describe("模型存别名，不存版本号——出新模型不用改代码", () => {
  it("以前存的具体版本号读成别名；认不出的回到跟随默认", () => {
    const file = join(config.dataDir, "settings.json");
    const put = (model: string) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), model }));
    updateSettings({ name: "x" });
    put("claude-sonnet-5");
    expect(userSettings().model).toBe("sonnet");
    put("claude-opus-5");
    expect(userSettings().model).toBe("opus");
    put("claude-haiku-4-5");
    expect(userSettings().model).toBe("haiku");
    put("claude-fable-5-1");
    expect(userSettings().model).toBe("claude-fable-5-1");
    put("gpt-9");
    expect(userSettings().model).toBe("");
  });
});

describe("自主开工的把握门槛", () => {
  it("默认 80；存的值钳在 50–100 之间、取整", () => {
    expect(userSettings().autonomousMinConfidence).toBe(80);
    expect(updateSettings({ autonomousMinConfidence: 75 }).autonomousMinConfidence).toBe(75);
    const file = join(config.dataDir, "settings.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), autonomousMinConfidence: 12 }));
    expect(userSettings().autonomousMinConfidence).toBe(50);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), autonomousMinConfidence: 120.6 }));
    expect(userSettings().autonomousMinConfidence).toBe(100);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), autonomousMinConfidence: "高" }));
    expect(userSettings().autonomousMinConfidence).toBe(80);
  });
});
