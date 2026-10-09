import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteResearchNote, listResearchNotes, readResearchByName, saveResearchNote } from "./research.js";

describe("学习笔记", () => {
  const at = new Date("2026-10-09T02:00:00Z");

  it("按上海日期 + 标题存，重名加序号，能按文件名读回", () => {
    const a = saveResearchNote("Refactoring UI / 中文版", "- 要点一", "https://v.example.com/p/x", at);
    const b = saveResearchNote("Refactoring UI / 中文版", "- 要点二", undefined, at);
    expect(a).toBe(join("research", "2026-10-09-Refactoring-UI-中文版.md"));
    expect(b).toBe(join("research", "2026-10-09-Refactoring-UI-中文版-2.md"));
    expect(listResearchNotes()).toContain("2026-10-09-Refactoring-UI-中文版.md");
    const note = readResearchByName("2026-10-09-Refactoring-UI-中文版");
    expect(note).toContain("- 来源：https://v.example.com/p/x");
    expect(note).toContain("- 要点一");
  });

  it("按文件名读挡掉 ../", () => {
    expect(readResearchByName("../settings.json")).toBe("");
  });

  it("撤销删掉那份笔记", () => {
    const rel = saveResearchNote("要删的", "x", undefined, at);
    expect(deleteResearchNote(rel)).toBe(true);
    expect(existsSync(join(process.env.FRIDAY_DATA_DIR!, rel))).toBe(false);
    expect(deleteResearchNote(rel)).toBe(false);
  });
});
