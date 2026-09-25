import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../../memory/tasks.js";
import { collectGit, collectTasks } from "./collect.js";
import { weekOf } from "./week.js";

const week = weekOf(new Date());

function repo(root: string, name: string, commits: Array<{ email: string; msg: string; date?: string }>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q");
  for (const [i, c] of commits.entries()) {
    writeFileSync(join(dir, `f${i}`), c.msg);
    git("add", ".");
    const env = { ...process.env, GIT_AUTHOR_DATE: c.date ?? new Date().toISOString(), GIT_COMMITTER_DATE: c.date ?? new Date().toISOString() };
    execFileSync("git", ["-C", dir, "-c", `user.email=${c.email}`, "-c", "user.name=x", "commit", "-q", "-m", c.msg], { env, stdio: "pipe" });
  }
  return dir;
}

describe("收素材", () => {
  it("git：只要自己两个邮箱域、本周的；两层目录都扫", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    repo(root, "a", [
      { email: "haoran.jing@longbridge.sg", msg: "feat: 出金规则" },
      { email: "someone@else.com", msg: "别人的" },
      { email: "haoran.jing@longbridge-inc.com", msg: "fix: 上个月的", date: "2020-01-01T00:00:00Z" },
    ]);
    repo(join(root, "group"), "b", [{ email: "haoran.jing@longbridge-inc.com", msg: "fix: 表格截断" }]);
    const got = (await collectGit([root], week)).map((m) => m.text);
    expect(got).toHaveLength(2);
    expect(got.some((t) => t.includes("a") && t.includes("feat: 出金规则"))).toBe(true);
    expect(got.some((t) => t.includes("b") && t.includes("fix: 表格截断"))).toBe(true);
  });

  it("git：不阻塞事件循环；多个仓库合在一起按时间倒序，截断时留下最新的", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const at = (h: number) => new Date(week.start.getTime() + h * 3600_000).toISOString();
    repo(root, "a", [{ email: "haoran.jing@longbridge.sg", msg: "a 早", date: at(1) }, { email: "haoran.jing@longbridge.sg", msg: "a 晚", date: at(30) }]);
    repo(root, "b", [{ email: "haoran.jing@longbridge.sg", msg: "b 中", date: at(10) }]);
    const pending = collectGit([root], week);
    expect(pending).toBeInstanceOf(Promise);
    const got = (await pending).map((m) => m.text);
    expect(got.map((t) => t.split(" ").slice(2).join(" "))).toEqual(["a 晚", "b 中", "a 早"]);
  });

  it("git：不收 stash（WIP on …）", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const dir = repo(root, "a", [{ email: "haoran.jing@longbridge.sg", msg: "feat: 正经提交" }]);
    writeFileSync(join(dir, "f0"), "改了没提交");
    execFileSync("git", ["-C", dir, "-c", "user.email=haoran.jing@longbridge.sg", "-c", "user.name=x", "stash", "-q"], { stdio: "pipe" });
    const got = (await collectGit([root], week)).map((m) => m.text);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("feat: 正经提交");
  });

  it("任务：本周动过的，排除 ignored 和周报 / 手册任务本身", () => {
    const keep = createTask({ title: "SaaS 计费明细", kind: "meegle", source: { meegleId: "24514104" }, status: "processing" });
    const ign = createTask({ title: "不管了", kind: "verbal", source: {}, status: "understood" });
    updateTask(ign.id, { status: "ignored" });
    createTask({ title: "OKR 周报 · x", kind: "okr_weekly", source: {}, status: "review" });
    const texts = collectTasks(week).map((m) => m.text);
    expect(texts.some((t) => t.includes("SaaS 计费明细") && t.includes("m-24514104"))).toBe(true);
    expect(texts.some((t) => t.includes("不管了") || t.includes("OKR 周报"))).toBe(false);
    expect(keep).toBeTruthy();
  });

  it("任务：还在待办里没动过的不算（Meegle 同步每 15 分钟会刷一遍 updatedAt）", () => {
    createTask({ title: "排队的需求", kind: "meegle", source: { meegleId: "1001" }, status: "understood", stage: "todo" });
    createTask({ title: "刚收进来的", kind: "verbal", source: {}, status: "collected" });
    createTask({ title: "待办里但已经在开发", kind: "meegle", source: { meegleId: "1002" }, status: "understood", stage: "dev" });
    const texts = collectTasks(week).map((m) => m.text);
    expect(texts.some((t) => t.includes("排队的需求") || t.includes("刚收进来的"))).toBe(false);
    expect(texts.some((t) => t.includes("待办里但已经在开发"))).toBe(true);
  });
});
