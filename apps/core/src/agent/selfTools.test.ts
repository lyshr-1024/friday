import { describe, expect, it, vi } from "vitest";

vi.mock("../memory/features.js", async (orig) => {
  const m = await orig<typeof import("../memory/features.js")>();
  return { ...m, writeKnowledge: vi.fn(m.writeKnowledge) };
});
import { fridayToolList } from "./tools.js";
import { saidLast, SETTINGS_KEYS } from "./selfTools.js";
import { addMessage, createConversation } from "../memory/conversations.js";
import { listAudit, undoPlan } from "../memory/audit.js";
import { updateSettings, userSettings } from "../settings.js";
import { subscribe } from "../bus.js";
import { db } from "../memory/db.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createTask } from "../memory/tasks.js";
import { createSchedule, updateSchedule } from "../memory/schedules.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { addRule, getRule, renderHandbook, restoreRules } from "../memory/rules.js";
import { addFeatureHistory, createFeature, featureHistory, findFeatureByName, getFeature, readKnowledge, restoreFeatures, writeKnowledge } from "../memory/features.js";
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

  it("已删的 autonomousMinConfidence 被拒，设置文件不变", async () => {
    const file = join(process.env.FRIDAY_DATA_DIR!, "settings.json");
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const out = await callIn(undefined, "settings_update", { patch: { autonomousMinConfidence: 70 } });
    expect(out).toContain("不能改");
    expect(existsSync(file) ? readFileSync(file, "utf8") : "").toBe(before);
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

  it("改任何键都发 settings 事件", async () => {
    const seen: string[] = [];
    const stop = subscribe((ev) => seen.push(ev.type));
    await callIn(undefined, "settings_update", { patch: { model: "sonnet" } });
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
    expect(plan).toMatchObject({ kind: "restore_project", name: "app" });
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

  it("friday 项目改方案送审：不写、不记账、回话说不生效", async () => {
    const fseed = `# 项目\n\n## friday\n- 目录：${dir}\n- 说明：旧\n`;
    writeMemoryFile("projects", fseed);
    const n = listAudit({}).filter((x) => x.action === "project_updated").length;
    const out = await callIn(undefined, "project_update", { project: "friday", fields: { 方案送审: "不用" } });
    expect(out).toContain("friday 项目的方案一律要你审，「方案送审」对它不生效");
    expect(readMemoryFile("projects")).toBe(fseed);
    expect(listAudit({}).filter((x) => x.action === "project_updated")).toHaveLength(n);
  });

  it("friday 项目方案送审 + 说明：说明写了、方案送审没写、回话带不生效那句", async () => {
    writeMemoryFile("projects", `# 项目\n\n## friday\n- 目录：${dir}\n`);
    const out = await callIn(undefined, "project_update", { project: "friday", fields: { 方案送审: "不用", 说明: "助理" } });
    expect(out).toContain("不生效");
    expect(readMemoryFile("projects")).toContain("- 说明：助理");
    expect(readMemoryFile("projects")).not.toContain("方案送审");
  });

  it("不许清空目录", async () => {
    writeMemoryFile("projects", seed);
    expect(await callIn(undefined, "project_update", { project: "app", fields: { 目录: "" } })).toContain("目录不能清空");
    expect(readMemoryFile("projects")).toBe(seed);
  });

  it("create 只认完全同名：模糊命中别的项目不改它", async () => {
    const seedWeb = `${seed}\n## web-admin\n- 目录：${dir}\n- 别名：后台\n`;
    writeMemoryFile("projects", seedWeb);
    const out = await callIn(undefined, "project_update", { project: "web", create: true, fields: { 目录: dir, 别名: "新" } });
    expect(out).toContain("已有相近的项目「web-admin」");
    expect(readMemoryFile("projects")).toBe(seedWeb);
    const same = await callIn(undefined, "project_update", { project: "APP", create: true, fields: { 说明: "同名" } });
    expect(same).toContain("- 说明：同名");
    expect(readMemoryFile("projects")).toContain("## app\n");
  });

  it("不带 create 时目录路径不算已有项目，不写文件", async () => {
    writeMemoryFile("projects", seed);
    const out = await callIn(undefined, "project_update", { project: dir, fields: { 别名: "x" } });
    expect(out).toContain("找不到");
    expect(readMemoryFile("projects")).toBe(seed);
  });

  it("目录要绝对路径或 ~ 开头，~ 照用户写的形式存", async () => {
    writeMemoryFile("projects", seed);
    expect(await callIn(undefined, "project_update", { project: "app", fields: { 目录: "relative/dir" } })).toContain("目录要写绝对路径");
    expect(readMemoryFile("projects")).toBe(seed);
    const oldHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "home-"));
    mkdirSync(join(home, "code"));
    process.env.HOME = home;
    try {
      const out = await callIn(undefined, "project_update", { project: "app", fields: { 目录: "~/code" } });
      expect(out).toContain("- 目录：~/code");
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it("记账撤销只带这一段", async () => {
    writeMemoryFile("projects", seed);
    await callIn(undefined, "project_update", { project: "app", fields: { 说明: "x" } });
    const e = listAudit({}).find((x) => x.action === "project_updated")!;
    expect(undoPlan(e.id)).toEqual({ kind: "restore_project", name: "app", before: seed.slice(seed.indexOf("## app")).trimEnd() });
  });

  it("定时会话里不能改配置，设置和项目文件不变", async () => {
    writeMemoryFile("projects", seed);
    const conv = createConversation().id;
    const s = createSchedule({ title: "cfg", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: conv });
    updateSettings({ autonomousConcurrency: 3 });
    const msg = "定时任务里不能改 Friday 的配置，等用户回来。";
    expect(await callIn(conv, "settings_update", { patch: { autonomousConcurrency: 7 } })).toBe(msg);
    expect(await callIn(conv, "project_update", { project: "app", fields: { 说明: "x" } })).toBe(msg);
    expect(await callIn(conv, "rule_update", { id: "r-x", text: "x" })).toBe(msg);
    expect(await callIn(conv, "rule_retire", { id: "r-x", why: "x" })).toBe(msg);
    expect(await callIn(conv, "knowledge_update", { op: "delete", id: "x" })).toBe(msg);
    expect(userSettings().autonomousConcurrency).toBe(3);
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

describe("knowledge_update", () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-proj-"));
  const seed = `# 项目\n\n## KbApp\n- 目录：${dir}\n\n## KbOther\n- 目录：${dir}\n`;
  const undoOf = (featureId: string) => {
    const e = listAudit({ limit: 500 }).find((x) => x.action === "knowledge_corrected" && (x.evidence.features as string[]).includes(featureId))!;
    const plan = undoPlan(e.id)!;
    if (plan.kind !== "restore_features") throw new Error();
    return { e, plan };
  };

  it("认「项目:功能名」（项目名大小写不敏感、功能名认别名），改字段、重渲染、可撤", async () => {
    writeMemoryFile("projects", seed);
    const f = createFeature("KbApp", { name: "基金筛选", aliases: ["筛选"], where: "A 仓" }, "task");
    const conv = createConversation().id;
    addMessage(conv, { role: "user", kind: "ask", content: "基金筛选在 B 仓" });
    const out = await callIn(conv, "knowledge_update", { op: "edit", id: "kbapp:筛选", patch: { where: "B 仓" } });
    expect(out).toContain("B 仓");
    expect(getFeature(f.id)).toMatchObject({ where: "B 仓", corrected: ["where"] });
    expect(readKnowledge("KbApp")).toContain("B 仓");
    const { e, plan } = undoOf(f.id);
    expect(e.evidence.quote).toBe("基金筛选在 B 仓");
    restoreFeatures(plan.snapshot);
    expect(getFeature(f.id)).toMatchObject({ where: "A 仓", corrected: [] });
  });

  it("owners 按键合并，空串删键，未知键被拒", async () => {
    writeMemoryFile("projects", seed);
    const f = createFeature("KbApp", { name: "负责人", owners: { backend: "甲", pm: "乙", design: "丙" } }, "task");
    await callIn(undefined, "knowledge_update", { op: "edit", id: f.id, patch: { owners: { backend: "丁" } } });
    expect(getFeature(f.id)!.owners).toEqual({ backend: "丁", pm: "乙", design: "丙" });
    expect(getFeature(f.id)!.corrected).toContain("owners");
    await callIn(undefined, "knowledge_update", { op: "edit", id: f.id, patch: { owners: { pm: "" } } });
    expect(getFeature(f.id)!.owners).toEqual({ backend: "丁", design: "丙" });
    expect(await callIn(undefined, "knowledge_update", { op: "edit", id: f.id, patch: { owners: { frontend: "戊" } } })).toContain("不能改");
    expect(getFeature(f.id)!.owners).toEqual({ backend: "丁", design: "丙" });
  });

  it("找不到、空 patch、未知键都回文本不抛", async () => {
    writeMemoryFile("projects", seed);
    const f = createFeature("KbApp", { name: "资金流水" }, "task");
    expect(await callIn(undefined, "knowledge_update", { op: "edit", id: "KbApp:没有", patch: { where: "x" } })).toContain("没找到这个功能");
    expect(await callIn(undefined, "knowledge_update", { op: "edit", id: f.id, patch: {} })).toContain("没有要改");
    expect(await callIn(undefined, "knowledge_update", { op: "edit", id: f.id, patch: { origin: "x" } })).toContain("不能改");
  });

  it("merge：跨项目被拒；同项目合并后可撤", async () => {
    writeMemoryFile("projects", seed);
    const k = createFeature("KbApp", { name: "提现" }, "task");
    const d = createFeature("KbApp", { name: "提现规则" }, "task");
    const o = createFeature("KbOther", { name: "别处" }, "task");
    addFeatureHistory({ featureId: d.id, at: "2026-10-01T00:00:00Z", what: "b", files: [] });
    expect(await callIn(undefined, "knowledge_update", { op: "merge", keep: k.id, drop: o.id })).toContain("同一个项目");
    await callIn(undefined, "knowledge_update", { op: "merge", keep: k.id, drop: d.id });
    expect(getFeature(d.id)).toBeUndefined();
    expect(getFeature(k.id)!.aliases).toContain("提现规则");
    expect(featureHistory(k.id)).toHaveLength(1);
    restoreFeatures(undoOf(d.id).plan.snapshot);
    expect(getFeature(d.id)).toBeTruthy();
    expect(featureHistory(d.id)).toHaveLength(1);
  });

  it("move：挪历史，to 认「项目:功能名」", async () => {
    writeMemoryFile("projects", seed);
    const a = createFeature("KbApp", { name: "移出方" }, "task");
    const b = createFeature("KbApp", { name: "移入方" }, "task");
    const h = addFeatureHistory({ featureId: a.id, at: "2026-10-01T00:00:00Z", what: "x", files: [] });
    await callIn(undefined, "knowledge_update", { op: "move", historyId: h, to: "KbApp:移入方" });
    expect(featureHistory(b.id).map((x) => x.id)).toEqual([h]);
    expect(await callIn(undefined, "knowledge_update", { op: "move", historyId: 999999, to: b.id })).toContain("没有这条历史");
    restoreFeatures(undoOf(a.id).plan.snapshot);
    expect(featureHistory(a.id).map((x) => x.id)).toEqual([h]);
  });

  it("delete 可撤：功能和历史回来", async () => {
    writeMemoryFile("projects", seed);
    const c = createFeature("KbApp", { name: "待删功能" }, "task");
    const h = addFeatureHistory({ featureId: c.id, at: "2026-10-01T00:00:00Z", what: "x", files: [] });
    await callIn(undefined, "knowledge_update", { op: "delete", id: c.id });
    expect(findFeatureByName("KbApp", "待删功能")).toBeUndefined();
    restoreFeatures(undoOf(c.id).plan.snapshot);
    expect(featureHistory(c.id).map((x) => x.id)).toEqual([h]);
  });

  it("渲染知识库文件出错也先把账记下，工具回文本不抛，撤销入口还在", async () => {
    writeMemoryFile("projects", seed);
    const f = createFeature("KbApp", { name: "渲染炸了" }, "task");
    vi.mocked(writeKnowledge).mockImplementationOnce(() => {
      throw new Error("磁盘满了");
    });
    const out = await callIn(undefined, "knowledge_update", { op: "delete", id: f.id });
    expect(out).toContain("已改并记账，但知识库文件没重新生成：磁盘满了");
    expect(out).toContain("可在操作记录里撤销");
    restoreFeatures(undoOf(f.id).plan.snapshot);
    expect(getFeature(f.id)?.name).toBe("渲染炸了");
  });

  it("合并中途抛错：回「没改成」，没有账，两条功能和历史都没变", async () => {
    writeMemoryFile("projects", seed);
    const k = createFeature("KbApp", { name: "合并留" }, "task");
    const d = createFeature("KbApp", { name: "合并丢" }, "task");
    const hk = addFeatureHistory({ featureId: k.id, at: "2026-10-01T00:00:00Z", what: "k", files: [] });
    const hd = addFeatureHistory({ featureId: d.id, at: "2026-10-02T00:00:00Z", what: "d", files: [] });
    const before = listAudit({ limit: 500 }).filter((x) => x.action === "knowledge_corrected").length;
    db().exec(`CREATE TRIGGER kb_boom BEFORE DELETE ON features WHEN OLD.id = '${d.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    try {
      const out = await callIn(undefined, "knowledge_update", { op: "merge", keep: k.id, drop: d.id });
      expect(out).toContain("没改成");
      expect(out).toContain("boom");
      expect(out).not.toContain("撤销");
    } finally {
      db().exec("DROP TRIGGER kb_boom");
    }
    expect(listAudit({ limit: 500 }).filter((x) => x.action === "knowledge_corrected").length).toBe(before);
    expect(getFeature(d.id)?.name).toBe("合并丢");
    expect(getFeature(k.id)?.aliases).toEqual([]);
    expect(featureHistory(k.id).map((x) => x.id)).toEqual([hk]);
    expect(featureHistory(d.id).map((x) => x.id)).toEqual([hd]);
  });

  it("edit 的撤销不动历史：先 edit、再把历史挪走、撤销 edit 后历史仍在目标上", async () => {
    writeMemoryFile("projects", seed);
    const f = createFeature("KbApp", { name: "编辑方", where: "A 仓" }, "task");
    const g = createFeature("KbApp", { name: "接收方" }, "task");
    const h = addFeatureHistory({ featureId: f.id, at: "2026-10-01T00:00:00Z", what: "x", files: [] });
    await callIn(undefined, "knowledge_update", { op: "edit", id: f.id, patch: { where: "B 仓" } });
    await callIn(undefined, "knowledge_update", { op: "move", historyId: h, to: g.id });
    const edit = listAudit({ limit: 500 }).filter((x) => x.action === "knowledge_corrected" && x.how.includes("where：A 仓"))[0]!;
    const plan = undoPlan(edit.id)!;
    if (plan.kind !== "restore_features") throw new Error();
    restoreFeatures(plan.snapshot);
    expect(getFeature(f.id)?.where).toBe("A 仓");
    expect(featureHistory(g.id).map((x) => x.id)).toEqual([h]);
    expect(featureHistory(f.id)).toEqual([]);
  });

  it("全角冒号也能拆「项目：功能名」", async () => {
    writeMemoryFile("projects", seed);
    const f = createFeature("KbApp", { name: "全角功能" }, "task");
    await callIn(undefined, "knowledge_update", { op: "edit", id: "KbApp：全角功能", patch: { summary: "s" } });
    expect(getFeature(f.id)?.summary).toBe("s");
  });

  it("owners 这类对象在回显里可读，不是 [object Object]", async () => {
    writeMemoryFile("projects", seed);
    const f = createFeature("KbApp", { name: "负责人功能" }, "task");
    const out = await callIn(undefined, "knowledge_update", { op: "edit", id: f.id, patch: { owners: { backend: "甲" } } });
    expect(out).toContain("backend");
    expect(out).not.toContain("[object Object]");
  });
});

describe("遗留 worktree 工具", () => {
  function repoWithWorktree() {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "swt-repo-")));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const tree = join(realpathSync(mkdtempSync(join(tmpdir(), "swt-tree-"))), "feat-y");
    git("worktree", "add", "-q", "-b", "feat/y", tree);
    return { repo, tree };
  }
  const say = (content: string) => {
    const conv = createConversation().id;
    addMessage(conv, { role: "user", kind: "ask", content });
    return conv;
  };

  it("worktrees_leftover 列路径 · 分支 · 改动 · 所属任务 #N，没有就说没有", async () => {
    const { repo, tree } = repoWithWorktree();
    const t = createTask({ title: "遗留列表", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const out = await callIn(undefined, "worktrees_leftover", {});
    expect(out).toContain(`${tree} · feat/y · 没有未提交改动 · 所属任务 #${t.seq}`);
    writeFileSync(join(tree, "wip.txt"), "x\n");
    expect(await callIn(undefined, "worktrees_leftover", {})).toContain(`${tree} · feat/y · 有未提交改动`);
    createTask({ title: "占着", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "review" });
    expect(await callIn(undefined, "worktrees_leftover", {})).not.toContain(tree);
  });

  it("路径不在遗留列表里 → 拒绝，不删", async () => {
    const { tree } = repoWithWorktree();
    const out = await callIn(say("删掉"), "worktree_remove", { path: tree });
    expect(out).toContain("这个路径不在遗留列表里，不删");
    expect(existsSync(tree)).toBe(true);
  });

  it("用户这句不是同意 → 只返回后果说明，不删", async () => {
    const { repo, tree } = repoWithWorktree();
    createTask({ title: "说明", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const out = await callIn(say("看看有哪些"), "worktree_remove", { path: tree });
    expect(out).toContain(`要删 ${tree}（分支 feat/y）。删了撤不回。确认的话请用户单独回一句「删掉」`);
    expect(existsSync(tree)).toBe(true);
  });

  it("用户回「删掉」→ 真删，记账带原话，说明分支去向", async () => {
    const { repo, tree } = repoWithWorktree();
    createTask({ title: "要删", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const conv = say("清一下遗留的");
    await callIn(conv, "worktree_remove", { path: tree });
    addMessage(conv, { role: "user", kind: "ask", content: "删掉" });
    const out = await callIn(conv, "worktree_remove", { path: tree });
    expect(existsSync(tree)).toBe(false);
    expect(out).toContain("feat/y");
    const e = listAudit({ limit: 10 }).find((x) => x.action === "worktree_removed" && x.evidence.path === tree)!;
    expect(e.evidence.quote).toBe("删掉");
    expect(e.risk).toBe("reversible");
  });

  it("有未提交改动：回「删掉」不删并要求「连改动一起删掉」；回「连改动一起删掉」才删", async () => {
    const { repo, tree } = repoWithWorktree();
    writeFileSync(join(tree, "wip.txt"), "x\n");
    createTask({ title: "有改动", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const conv = say("清一下遗留的");
    await callIn(conv, "worktree_remove", { path: tree });
    addMessage(conv, { role: "user", kind: "ask", content: "删掉" });
    const out = await callIn(conv, "worktree_remove", { path: tree });
    expect(out).toContain("里面有没提交的改动，会一起丢。确认请回「连改动一起删掉」");
    expect(existsSync(tree)).toBe(true);
    addMessage(conv, { role: "user", kind: "ask", content: "连改动一起删掉" });
    await callIn(conv, "worktree_remove", { path: tree });
    expect(existsSync(tree)).toBe(false);
    expect(listAudit({ limit: 10 }).find((x) => x.action === "worktree_removed" && x.evidence.path === tree)?.risk).toBe("irreversible");
  });

  it("定时任务的会话里硬拒", async () => {
    const { repo, tree } = repoWithWorktree();
    createTask({ title: "定时拒", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const conv = say("删掉");
    const s = createSchedule({ title: "x", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: conv });
    expect(await callIn(conv, "worktree_remove", { path: tree })).toBe("定时任务里不能删 worktree，等用户回来。");
    expect(existsSync(tree)).toBe(true);
  });

  it("同意只对上一轮问过的路径有效，没问过的照样先问", async () => {
    const a = repoWithWorktree();
    const b = repoWithWorktree();
    createTask({ title: "A", kind: "verbal", source: { worktree: a.tree, repoDir: a.repo }, status: "done" });
    createTask({ title: "B", kind: "verbal", source: { worktree: b.tree, repoDir: b.repo }, status: "done" });
    const conv = say("清一下");
    await callIn(conv, "worktree_remove", { path: a.tree });
    addMessage(conv, { role: "user", kind: "ask", content: "删掉" });
    const outB = await callIn(conv, "worktree_remove", { path: b.tree });
    expect(outB).toContain(`要删 ${b.tree}`);
    expect(existsSync(b.tree)).toBe(true);
    await callIn(conv, "worktree_remove", { path: a.tree });
    expect(existsSync(a.tree)).toBe(false);
  });

  it("一轮问了几个，下一句「删掉」全部删掉，不管调用顺序", async () => {
    const trees = [repoWithWorktree(), repoWithWorktree(), repoWithWorktree()];
    for (const t of trees) createTask({ title: "批", kind: "verbal", source: { worktree: t.tree, repoDir: t.repo }, status: "done" });
    const conv = say("把遗留的都清了");
    for (const t of trees) await callIn(conv, "worktree_remove", { path: t.tree });
    addMessage(conv, { role: "user", kind: "ask", content: "删掉" });
    for (const t of trees) await callIn(conv, "worktree_remove", { path: t.tree });
    for (const t of trees) expect(existsSync(t.tree)).toBe(false);
  });

  it("列过清单就算问过：下一句「删掉」直接删干净的，有改动的仍要「连改动一起删掉」", async () => {
    const clean = repoWithWorktree();
    const dirty = repoWithWorktree();
    writeFileSync(join(dirty.tree, "wip.txt"), "x\n");
    createTask({ title: "干净", kind: "verbal", source: { worktree: clean.tree, repoDir: clean.repo }, status: "done" });
    createTask({ title: "有改动", kind: "verbal", source: { worktree: dirty.tree, repoDir: dirty.repo }, status: "done" });
    const conv = say("把任务清理一下");
    await callIn(conv, "worktrees_leftover", {});
    addMessage(conv, { role: "user", kind: "ask", content: "删掉" });
    await callIn(conv, "worktree_remove", { path: clean.tree });
    const out = await callIn(conv, "worktree_remove", { path: dirty.tree });
    expect(existsSync(clean.tree)).toBe(false);
    expect(existsSync(dirty.tree)).toBe(true);
    expect(out).toContain("确认请回「连改动一起删掉」");
  });

  it("确认提示告诉模型已登记、下一句同意再调就会删", async () => {
    const { repo, tree } = repoWithWorktree();
    createTask({ title: "提示", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const out = await callIn(say("看看"), "worktree_remove", { path: tree });
    expect(out).toContain("已登记");
  });

  it("问过以后隔了一句别的话，再说「删掉」不算，重新问", async () => {
    const { repo, tree } = repoWithWorktree();
    createTask({ title: "隔一句", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const conv = say("清一下");
    await callIn(conv, "worktree_remove", { path: tree });
    addMessage(conv, { role: "user", kind: "ask", content: "先看看别的" });
    addMessage(conv, { role: "user", kind: "ask", content: "删掉" });
    const out = await callIn(conv, "worktree_remove", { path: tree });
    expect(out).toContain(`要删 ${tree}`);
    expect(existsSync(tree)).toBe(true);
  });

  it("没问过直接回「删掉」→ 不删，返回说明", async () => {
    const { repo, tree } = repoWithWorktree();
    createTask({ title: "没问过", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const out = await callIn(say("删掉"), "worktree_remove", { path: tree });
    expect(out).toContain(`要删 ${tree}`);
    expect(existsSync(tree)).toBe(true);
  });

  it("问时干净、之后有了改动，回「删掉」不删，要求「连改动一起删掉」", async () => {
    const { repo, tree } = repoWithWorktree();
    createTask({ title: "后来变脏", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const conv = say("清一下");
    await callIn(conv, "worktree_remove", { path: tree });
    writeFileSync(join(tree, "late.txt"), "x\n");
    addMessage(conv, { role: "user", kind: "ask", content: "删掉" });
    const out = await callIn(conv, "worktree_remove", { path: tree });
    expect(out).toContain("确认请回「连改动一起删掉」");
    expect(existsSync(tree)).toBe(true);
    addMessage(conv, { role: "user", kind: "ask", content: "连改动一起删掉" });
    await callIn(conv, "worktree_remove", { path: tree });
    expect(existsSync(tree)).toBe(false);
  });

  it("同一轮里对同一个路径连调两次，凭同一句「删掉」也删不掉；用户在被问之后再说一句才删", async () => {
    const { repo, tree } = repoWithWorktree();
    createTask({ title: "连调", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const conv = say("删掉");
    await callIn(conv, "worktree_remove", { path: tree });
    await callIn(conv, "worktree_remove", { path: tree });
    expect(existsSync(tree)).toBe(true);
    addMessage(conv, { role: "user", kind: "ask", content: "删掉" });
    await callIn(conv, "worktree_remove", { path: tree });
    expect(existsSync(tree)).toBe(false);
  });
});

describe("自管工具的小修", () => {
  it("rule_update 文字没变：不调 editRule、不记账、origin 不变", async () => {
    const r = addRule({ project: "_global", section: "约定", text: "一律用中文", origin: "history", evidence: [{ quote: "q", at: "2026-10-01T00:00:00.000Z", kind: "utterance" }] });
    const n = listAudit({}).filter((x) => x.action === "rule_changed").length;
    const out = await callIn(undefined, "rule_update", { id: r.id, text: "  一律用中文 " });
    expect(out).toContain("没有变化");
    expect(listAudit({}).filter((x) => x.action === "rule_changed")).toHaveLength(n);
    expect(getRule(r.id)!.origin).toBe("history");
  });

  it("无 conversationId 记账：why 不说「你在对话里」", async () => {
    updateSettings({ autonomousConcurrency: 3 });
    await callIn(undefined, "settings_update", { patch: { autonomousConcurrency: 4 } });
    const e = listAudit({}).find((x) => x.action === "settings_changed")!;
    expect(e.why).not.toContain("你在对话里");
    expect(e.why).toContain("Friday 自己调用");
  });
});
