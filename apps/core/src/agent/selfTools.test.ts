import { describe, expect, it, vi } from "vitest";
import { fridayToolList } from "./tools.js";
import { saidLast, SETTINGS_KEYS } from "./selfTools.js";
import { addMessage, createConversation } from "../memory/conversations.js";
import { listAudit, undoPlan } from "../memory/audit.js";
import { updateSettings, userSettings } from "../settings.js";
import { subscribe } from "../bus.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { addRule, getRule, renderHandbook, restoreRules } from "../memory/rules.js";
import { readHandbook, writeHandbook } from "../memory/handbooks.js";

const callIn = async (conv: string | undefined, name: string, args: Record<string, unknown>) => {
  const t = fridayToolList(conv).find((x) => x.name === name)!;
  return ((await t.handler(args as never, {})).content[0] as { text: string }).text;
};

describe("settings 工具", () => {
  it("settings_update 改白名单里的键，记账带原话和撤销", async () => {
    updateSettings({ autonomousConcurrency: 3 });
    const conv = createConversation().id;
    addMessage(conv, { role: "user", kind: "ask", content: "并发改成 5" });
    const out = await callIn(conv, "settings_update", { patch: { autonomousConcurrency: 5 } });
    expect(out).toBe("改好了：autonomousConcurrency：3 → 5（可在操作记录里撤销）");
    expect(userSettings().autonomousConcurrency).toBe(5);
    const e = listAudit({}).find((x) => x.action === "settings_changed")!;
    expect(e.evidence.quote).toBe("并发改成 5");
    expect(undoPlan(e.id)).toMatchObject({ kind: "restore_settings", before: { autonomousConcurrency: 3 } });
  });

  it("白名单外的键（hotkey）被拒", async () => {
    const out = await callIn(undefined, "settings_update", { patch: { hotkey: "A", autonomousConcurrency: 2 } });
    expect(out).toContain("不能改");
    expect(userSettings().autonomousConcurrency).not.toBe(2);
  });

  it("值不合规被拒", async () => {
    const out = await callIn(undefined, "settings_update", { patch: { autonomousConcurrency: 99 } });
    expect(out).toContain("不能改");
    expect(userSettings().autonomousConcurrency).not.toBe(99);
  });

  it("撤销只还原这次动过的键", async () => {
    updateSettings({ model: "", skills: true });
    await callIn(undefined, "settings_update", { patch: { model: "opus" } });
    updateSettings({ skills: false });
    const e = listAudit({}).find((x) => x.action === "settings_changed")!;
    const plan = undoPlan(e.id)!;
    expect(plan).toMatchObject({ kind: "restore_settings", before: { model: "" } });
    if (plan.kind !== "restore_settings") throw new Error();
    updateSettings(plan.before);
    expect(userSettings().model).toBe("");
    expect(userSettings().skills).toBe(false);
  });

  it("没有会话 / 没有用户消息时原话记空串，不抛", async () => {
    expect(saidLast(undefined)).toBe("");
    expect(saidLast(createConversation().id)).toBe("");
    await callIn(undefined, "settings_update", { patch: { name: "阿甲" } });
    expect(listAudit({}).find((x) => x.action === "settings_changed")!.evidence.quote).toBe("");
  });

  it("改 theme 发 settings 事件，别的键不发", async () => {
    const seen: string[] = [];
    const stop = subscribe((ev) => seen.push(ev.type));
    await callIn(undefined, "settings_update", { patch: { okrWeekly: false } });
    expect(seen).not.toContain("settings");
    await callIn(undefined, "settings_update", { patch: { theme: "light" } });
    stop();
    expect(seen).toContain("settings");
  });

  it("settings_get 列出白名单每个键", async () => {
    const out = await callIn(undefined, "settings_get", {});
    const lines = out.split("\n");
    expect(lines).toHaveLength(SETTINGS_KEYS.length);
    for (const k of SETTINGS_KEYS) expect(lines.some((l) => l.startsWith(`${k}：`))).toBe(true);
  });
});

describe("project_update", () => {
  const dir = mkdtempSync(join(tmpdir(), "proj-"));
  const seed = `# 项目\n\n## app\n- 目录：${dir}\n- 别名：老名\n`;

  it("改保护分支，记账可撤", async () => {
    writeMemoryFile("projects", seed);
    const conv = createConversation().id;
    addMessage(conv, { role: "user", kind: "ask", content: "app 的保护分支加上 sit" });
    const out = await callIn(conv, "project_update", { project: "app", fields: { 保护分支: "main, sit" } });
    expect(out).toContain("- 保护分支：main, sit");
    expect(readMemoryFile("projects")).toContain("- 保护分支：main, sit");
    const e = listAudit({}).find((x) => x.action === "project_updated")!;
    expect(e.evidence.quote).toBe("app 的保护分支加上 sit");
    const plan = undoPlan(e.id)!;
    if (plan.kind !== "restore_memory") throw new Error();
    expect(plan.snapshot.projects).toBe(seed);
  });

  it("目录不存在就拒绝、方案送审只认三档", async () => {
    writeMemoryFile("projects", seed);
    expect(await callIn(undefined, "project_update", { project: "app", fields: { 目录: "/no/such/dir-xyz" } })).toContain("不存在");
    expect(await callIn(undefined, "project_update", { project: "app", fields: { 方案送审: "随便" } })).toContain("全部");
    expect(readMemoryFile("projects")).toBe(seed);
    expect(await callIn(undefined, "project_update", { project: "app", fields: { 方案送审: "大的" } })).toContain("- 方案送审：大的");
  });

  it("create 新建项目要目录", async () => {
    writeMemoryFile("projects", seed);
    expect(await callIn(undefined, "project_update", { project: "newp", create: true, fields: {} })).toContain("目录");
    const out = await callIn(undefined, "project_update", { project: "newp", create: true, fields: { 目录: dir, 别名: "新" } });
    expect(out).toContain("## newp");
    expect(readMemoryFile("projects")).toContain("## newp");
    expect(await callIn(undefined, "project_update", { project: "ghost", fields: { 别名: "x" } })).toContain("找不到");
  });

  it("memory_write projects 被引去 project_update，文件不变", async () => {
    writeMemoryFile("projects", seed);
    const out = await callIn(undefined, "memory_write", { file: "projects", content: "乱写" });
    expect(out).toContain("project_update");
    expect(readFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), "utf8")).toBe(seed);
  });

  it("不许清空目录", async () => {
    writeMemoryFile("projects", seed);
    expect(await callIn(undefined, "project_update", { project: "app", fields: { 目录: "" } })).toContain("目录不能清空");
    expect(readMemoryFile("projects")).toBe(seed);
  });

  it("新建项目名要干净", async () => {
    writeMemoryFile("projects", seed);
    for (const bad of ["", "  ", "a\nb", "# x"]) {
      expect(await callIn(undefined, "project_update", { project: bad, create: true, fields: { 目录: dir } })).toContain("项目名");
    }
    expect(readMemoryFile("projects")).toBe(seed);
  });
});

describe("手册规则工具", () => {
  const mk = (project: string, text: string) => addRule({ project, section: "约定", text, origin: "history", evidence: [{ quote: "q", at: new Date().toISOString(), kind: "utterance" }] });
  const undo = (id: string) => {
    const plan = undoPlan(id)!;
    if (plan.kind !== "restore_rules") throw new Error();
    for (const p of restoreRules(plan.snapshot)) writeHandbook(p, renderHandbook(p));
  };

  it("rule_update 改文字：手册是新文字，撤销回旧文字", async () => {
    const r = mk("rp1", "旧文字");
    const conv = createConversation().id;
    addMessage(conv, { role: "user", kind: "ask", content: "把那条改成新文字" });
    const out = await callIn(conv, "rule_update", { id: r.id, text: "新文字" });
    expect(out).toContain("新文字");
    expect(readHandbook("rp1")).toContain("新文字");
    const e = listAudit({}).find((x) => x.action === "rule_changed")!;
    expect(e.evidence).toMatchObject({ quote: "把那条改成新文字", before: "旧文字", after: "新文字" });
    undo(e.id);
    expect(getRule(r.id)!.text).toBe("旧文字");
    expect(readHandbook("rp1")).toContain("旧文字");
    expect(readHandbook("rp1")).not.toContain("新文字");
  });

  it("rule_update 超长或不存在被拒", async () => {
    const r = mk("rp2", "x");
    expect(await callIn(undefined, "rule_update", { id: r.id, text: "长".repeat(121) })).toContain("120");
    expect(await callIn(undefined, "rule_update", { id: "r-nope", text: "y" })).toBe("没有这条规则");
    expect(getRule(r.id)!.text).toBe("x");
  });

  it("rule_retire 必须给 why，退役后撤销回到 active", async () => {
    const r = mk("rp3", "要退役");
    expect(await callIn(undefined, "rule_retire", { id: r.id, why: "  " })).toContain("原因");
    expect(getRule(r.id)!.status).toBe("active");
    await callIn(undefined, "rule_retire", { id: r.id, why: "过时了" });
    expect(getRule(r.id)).toMatchObject({ status: "retired", retiredWhy: "过时了" });
    expect(readHandbook("rp3")).not.toContain("要退役");
    const e = listAudit({}).find((x) => x.action === "rule_retired")!;
    undo(e.id);
    expect(getRule(r.id)!.status).toBe("active");
    expect(readHandbook("rp3")).toContain("要退役");
    expect(await callIn(undefined, "rule_retire", { id: r.id, why: "再退" })).not.toContain("已经退役");
    const n = listAudit({}).filter((x) => x.action === "rule_retired").length;
    expect(await callIn(undefined, "rule_retire", { id: r.id, why: "又退" })).toBe("这条已经退役了");
    expect(listAudit({}).filter((x) => x.action === "rule_retired")).toHaveLength(n);
  });

  it("rules_list 不给项目时 _global 在前、按项目分组", async () => {
    const g = mk("_global", "全局一条");
    const b = mk("zz-b", "B 一条");
    const a = mk("zz-a", "A 一条");
    const out = await callIn(undefined, "rules_list", {});
    const iG = out.indexOf("【_global】"), iA = out.indexOf("【zz-a】"), iB = out.indexOf("【zz-b】");
    expect(iG).toBeGreaterThanOrEqual(0);
    expect(iG).toBeLessThan(iA);
    expect(iA).toBeLessThan(iB);
    expect(out).toContain(`${a.id} · 约定 · A 一条`);
    expect(out).toContain(g.id);
    expect(out).toContain(b.id);
    const only = await callIn(undefined, "rules_list", { project: "zz-a" });
    expect(only).toContain("A 一条");
    expect(only).not.toContain("B 一条");
    expect(await callIn(undefined, "rules_list", { project: "没有的项目" })).toBe("还没有规则");
  });
});
