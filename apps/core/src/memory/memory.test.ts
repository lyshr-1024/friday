import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { db, initMemory } from "./db.js";
import { undoWrite } from "./files.js";

const dir = process.env.FRIDAY_DATA_DIR!;

describe("记忆库", () => {
  it("首次初始化创建目录、markdown 模板和 todos.db", () => {
    initMemory(dir);
    expect(existsSync(join(dir, "logs"))).toBe(true);
    expect(existsSync(join(dir, "todos.db"))).toBe(true);
    expect(readFileSync(join(dir, "projects.md"), "utf8")).toContain("# 项目注册表");
  });

  it("再次初始化不覆盖已有 markdown", () => {
    const file = join(dir, "projects.md");
    const before = readFileSync(file, "utf8") + "\n## 手写内容\n";
    writeFileSync(file, before);
    initMemory(dir);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("旧账本的 delete_todo 仍能撤销", () => {
    db().prepare("INSERT INTO todos (id, text, source, created_at, done) VALUES (?, ?, 'local', ?, 0)").run("t-legacy", "旧待办", new Date().toISOString());
    expect(undoWrite({ kind: "delete_todo", id: "t-legacy" })).toBe(true);
    expect(db().prepare("SELECT 1 FROM todos WHERE id = ?").get("t-legacy")).toBeUndefined();
  });
});
