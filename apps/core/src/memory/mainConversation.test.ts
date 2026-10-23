import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcriptPath } from "../agent/runner.js";
import { config } from "../config.js";
import { addMessage, createConversation, deleteConversation, listMessages, listMessagesForTask, setClaudeSessionId } from "./conversations.js";
import { mainConversationId, mainResume, recentDialogue } from "./mainConversation.js";
import { db } from "./db.js";
import { getCursor, setCursor } from "./inbox.js";
import { createTask } from "./tasks.js";

let home = "";
let realHome: string | undefined;
function transcript(): string {
  const sid = randomUUID();
  const p = transcriptPath(config.dataDir, sid);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "");
  return sid;
}
beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "friday-home-"));
  process.env.HOME = home;
  const old = getCursor("main:conversation");
  if (old) deleteConversation(old);
  db().exec("DELETE FROM sync_state WHERE source IN ('main:conversation', 'main:session:since')");
});
afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe("主对话", () => {
  it("只有一段：两次取同一个 id；那段被删了就新建", () => {
    const a = mainConversationId();
    expect(mainConversationId()).toBe(a);
    deleteConversation(a);
    expect(mainConversationId()).not.toBe(a);
  });

  it("换日换新的 Claude session；首次调用只记 since 不轮换", () => {
    const id = mainConversationId();
    const s = transcript();
    setClaudeSessionId(id, s);
    expect(mainResume(new Date("2026-10-22T02:00:00Z"))).toBe(s);
    expect(mainResume(new Date("2026-10-22T03:00:00Z"))).toBe(s);
    expect(mainResume(new Date("2026-10-23T02:00:00Z"))).toBeUndefined();
  });

  it("上海日期按东八区算：UTC 16:00 已是第二天", () => {
    const id = mainConversationId();
    setClaudeSessionId(id, transcript());
    setCursor("main:session:since", new Date("2026-10-22T10:00:00Z").toISOString());
    expect(mainResume(new Date("2026-10-22T15:59:00Z"))).toBeDefined();
    expect(mainResume(new Date("2026-10-22T16:00:00Z"))).toBeUndefined();
  });

  it("transcript 不在就不 resume", () => {
    const id = mainConversationId();
    setClaudeSessionId(id, randomUUID());
    setCursor("main:session:since", new Date("2026-10-22T02:00:00Z").toISOString());
    expect(mainResume(new Date("2026-10-22T03:00:00Z"))).toBeUndefined();
  });

  it("since 之后用户消息满 40 条换新", () => {
    const id = mainConversationId();
    setClaudeSessionId(id, transcript());
    const since = new Date(Date.now() - 1000).toISOString();
    setCursor("main:session:since", since);
    const today = new Date();
    for (let i = 0; i < 39; i++) addMessage(id, { role: "user", kind: "ask", content: `q${i}` });
    addMessage(id, { role: "assistant", kind: "ask", content: "a" });
    expect(mainResume(today)).toBeDefined();
    addMessage(id, { role: "user", kind: "ask", content: "q39" });
    expect(mainResume(today)).toBeUndefined();
  });
});

describe("换会话后补上最近的对话", () => {
  it("取最后几条：用户、Friday、主动消息各标清楚，跳过报错，按时间顺序", () => {
    const id = mainConversationId();
    addMessage(id, { role: "user", kind: "ask", content: "很早的一句" });
    for (let i = 0; i < 10; i++) addMessage(id, { role: "user", kind: "ask", content: `第${i}句` });
    addMessage(id, { role: "assistant", kind: "notice", content: "#3 修登录 · 待验收" });
    addMessage(id, { role: "assistant", kind: "error", content: "连不上" });
    addMessage(id, { role: "assistant", kind: "ask", content: "要删这 5 个，回「删掉」" });
    const out = recentDialogue(id);
    expect(out).not.toContain("很早的一句");
    expect(out).not.toContain("连不上");
    expect(out).toContain("用户：第9句");
    expect(out).toContain("Friday（主动）：#3 修登录 · 待验收");
    expect(out.indexOf("用户：第9句")).toBeLessThan(out.indexOf("Friday：要删这 5 个，回「删掉」"));
  });

  it("单条截断、整块超长从最早的砍，没有消息就空串", () => {
    const empty = createConversation().id;
    expect(recentDialogue(empty)).toBe("");
    const id = mainConversationId();
    for (let i = 0; i < 10; i++) addMessage(id, { role: "user", kind: "ask", content: `${i}`.repeat(1000) });
    const out = recentDialogue(id);
    expect(out.length).toBeLessThanOrEqual(2200);
    expect(out).toContain("9".repeat(100));
    expect(out).not.toContain("0".repeat(100));
  });
});

describe("消息挂任务", () => {
  it("taskIds 存取", () => {
    const c = createConversation();
    const m = addMessage(c.id, { role: "user", kind: "ask", content: "x", taskIds: ["t1", "t2"] });
    expect(m.taskIds).toEqual(["t1", "t2"]);
    expect(listMessages(c.id)[0]!.taskIds).toEqual(["t1", "t2"]);
    expect(addMessage(c.id, { role: "user", kind: "ask", content: "y" }).taskIds).toBeUndefined();
  });

  it("listMessagesForTask：主对话里挂了它的 + 它自己的旧会话，按时间排", () => {
    const main = mainConversationId();
    const own = createConversation().id;
    const t = createTask({ title: "x", kind: "verbal", source: { conversationId: own } });
    const m1 = addMessage(own, { role: "user", kind: "ask", content: "own1" });
    const m2 = addMessage(main, { role: "user", kind: "ask", content: "main-hit", taskIds: [t.id, "other"] });
    addMessage(main, { role: "user", kind: "ask", content: "main-miss", taskIds: ["other"] });
    addMessage(main, { role: "user", kind: "ask", content: "main-none" });
    const m3 = addMessage(own, { role: "assistant", kind: "ask", content: "own2" });
    expect(listMessagesForTask(t.id).map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
  });
});
