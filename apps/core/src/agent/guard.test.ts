import { describe, expect, it } from "vitest";
import { buildHookSettings } from "./runner.js";
import { forbidden, forbiddenTool, isProtected } from "./guard.js";

describe("自主任务禁止的命令：只守保护分支，其余 git 操作全放", () => {
  it("切到、删掉、改名保护分支都拦，默认名单含主干和环境分支", () => {
    expect(forbidden("git checkout main")).toBeTruthy();
    expect(forbidden("git switch master")).toBeTruthy();
    expect(forbidden("git checkout release/saas")).toBeTruthy();
    expect(forbidden("git branch -D main")).toBeTruthy();
    expect(forbidden("git branch -m master old-master")).toBeTruthy();
    expect(forbidden("pnpm test && git switch sit")).toBeTruthy();
    expect(forbidden("sudo rm /etc/hosts")).toBeTruthy();
    expect(forbidden("rm -rf ~")).toBeTruthy();
  });

  it("项目自己的名单整体替换默认名单，* 通配，裸名盖住子路径", () => {
    const own = ["trunk", "canary*"];
    expect(forbidden("git checkout canary-3", own)).toBeTruthy();
    expect(forbidden("git switch trunk", own)).toBeTruthy();
    expect(forbidden("git checkout main", own)).toBeUndefined();
    expect(isProtected("release/saas", ["release"])).toBe(true);
    expect(isProtected("released", ["release"])).toBe(false);
    expect(isProtected("canary-3", ["canary*"])).toBe(true);
  });

  it("git 全局选项插在子命令前面也拦得住", () => {
    expect(forbidden("git -C /tmp/x checkout main")).toBeTruthy();
    expect(forbidden("git --no-pager switch master")).toBeTruthy();
  });

  it("开发分支上的 rebase / merge / reset --hard / 删分支都放；push 不在这里判（问 core）", () => {
    for (const ok of [
      "git rebase -i HEAD~2",
      "git rebase --onto origin/main abc feat/x",
      "git merge main",
      "git reset --hard HEAD~1",
      "git branch -D feat/old",
      "git checkout -b feat/x main",
      "git switch -c feat/y origin/main",
      "git push origin HEAD",
      "git push --force-with-lease origin feat/x",
      "pnpm test",
      "git status --short",
      "rm -rf node_modules/.cache",
    ]) {
      expect(forbidden(ok), ok).toBeUndefined();
    }
  });
});

describe("hook 设置", () => {
  it("自主任务挂 Bash 守卫，交互式终端只留提问 hook", () => {
    const matchers = (guard?: string) =>
      (JSON.parse(buildHookSettings("/r/x.hook.sh", guard)) as { hooks: { PreToolUse: Array<{ matcher: string }> } }).hooks.PreToolUse.map((h) => h.matcher);
    expect(matchers("/r/x.guard.sh")).toEqual(["Bash", "AskUserQuestion|ExitPlanMode"]);
    expect(matchers()).toEqual(["AskUserQuestion|ExitPlanMode"]);
  });
});

describe("只读任务的工具守卫", () => {
  it("改文件的工具一律拦下", () => {
    expect(forbiddenTool("Edit")).toBeTruthy();
    expect(forbiddenTool("Write")).toBeTruthy();
    expect(forbiddenTool("MultiEdit")).toBeTruthy();
    expect(forbiddenTool("NotebookEdit")).toBeTruthy();
  });

  it("读和搜不拦", () => {
    expect(forbiddenTool("Read")).toBeUndefined();
    expect(forbiddenTool("Grep")).toBeUndefined();
    expect(forbiddenTool("Glob")).toBeUndefined();
    expect(forbiddenTool("Bash")).toBeUndefined();
  });
});

describe("已登记工具的命令行", () => {
  const b = ["meegle", "lark-cli"];
  it("命令位置出现就拦", () => {
    for (const c of ["meegle mywork todo", "/opt/homebrew/bin/meegle workitem get", "cd x && meegle auth status", "npx lark-cli docs +fetch --doc u", "echo $(lark-cli docs +fetch)", "pnpm dlx meegle x"])
      expect(forbidden(c, [], b), c).toContain("已登记为 Friday 的外部工具");
  });
  it("作为参数或文件名不拦", () => {
    for (const c of ["cat meegle.md", "grep -rn lark-cli docs/", "git commit -m 'fix meegle sync'"]) expect(forbidden(c, [], b), c).toBeUndefined();
  });
  it("换行、花括号、then/do/else、env/time/变量前缀也是命令位置", () => {
    for (const c of ["cd x\nmeegle mywork", "if true; then meegle x; fi", "{ meegle x; }", "for i in 1; do lark-cli x; done", "env FOO=1 meegle x", "time lark-cli docs", "A=1 B=2 meegle x"])
      expect(forbidden(c, [], b), c).toContain("已登记为 Friday 的外部工具");
  });
});
