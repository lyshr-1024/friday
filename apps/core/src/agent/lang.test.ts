import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { replyLanguageLine, userLanguage } from "./lang.js";

const file = process.env.FRIDAY_CLAUDE_SETTINGS!;
const put = (v: unknown) => writeFileSync(file, JSON.stringify(v));

describe("用户常用语言：读 ~/.claude/settings.json 的 language", () => {
  afterEach(() => rmSync(file, { force: true }));

  it("chinese → 中文；english → English；认不出的原样用", () => {
    put({ language: "chinese" });
    expect(userLanguage()).toBe("中文");
    put({ language: "English" });
    expect(userLanguage()).toBe("English");
    put({ language: "français" });
    expect(userLanguage()).toBe("français");
  });

  it("没配、文件不在、文件坏了：undefined", () => {
    expect(userLanguage()).toBeUndefined();
    put({ theme: "dark" });
    expect(userLanguage()).toBeUndefined();
    writeFileSync(file, "{不是 json");
    expect(userLanguage()).toBeUndefined();
  });

  it("提示语：配了就点名语言，没配就跟着用户说话的语言", () => {
    put({ language: "chinese" });
    expect(replyLanguageLine()).toContain("用中文");
    rmSync(file, { force: true });
    expect(replyLanguageLine()).toContain("用户说话用的语言");
  });
});
