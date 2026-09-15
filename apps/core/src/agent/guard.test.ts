import { describe, expect, it } from "vitest";
import { buildHookSettings } from "./runner.js";
import { forbidden } from "./guard.js";

describe("自主任务禁止的命令", () => {
  it("拦下不可逆或越权的操作", () => {
    expect(forbidden("git push origin HEAD")).toBeTruthy();
    expect(forbidden("pnpm test && git push -u origin friday/ab")).toBeTruthy();
    expect(forbidden("git merge main")).toBeTruthy();
    expect(forbidden("git rebase -i HEAD~2")).toBeTruthy();
    expect(forbidden("git reset --hard HEAD~1")).toBeTruthy();
    expect(forbidden("git checkout main")).toBeTruthy();
    expect(forbidden("sudo rm /etc/hosts")).toBeTruthy();
    expect(forbidden("rm -rf ~")).toBeTruthy();
  });

  it("git 全局选项插在子命令前面也拦得住", () => {
    expect(forbidden("git -C /tmp/x push")).toBeTruthy();
    expect(forbidden("git --no-pager push")).toBeTruthy();
    expect(forbidden("git -c user.email=x merge main")).toBeTruthy();
  });

  it("放行干活需要的命令", () => {
    for (const ok of ["pnpm test", "pnpm typecheck", "git status --short", "git diff", "git add -A", 'git commit -m "修登录报错"', "git checkout -b friday/ab12cd34", "npx vitest run", "rm -rf node_modules/.cache"]) {
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
