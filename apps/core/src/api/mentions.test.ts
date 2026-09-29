import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { app } from "./index.js";
import { addPending, createTask, getTask } from "../memory/tasks.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { listAudit } from "../memory/audit.js";
import { migrate } from "../memory/db.js";
import { SCHEMA } from "../memory/schema.js";
import { fridayToolList } from "../agent/tools.js";

vi.mock("../connectors/keychain.js", () => ({ keychainGet: async () => undefined }));

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const mention = (id: string, body: unknown) =>
  app.request(`/tasks/${id}/mention`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function callTool(conversationId: string | undefined, name: string, args: Record<string, unknown>): Promise<string> {
  const t = fridayToolList(conversationId).find((x) => x.name === name)!;
  const r = (await t.handler(args as never, {})) as { content: Array<{ text: string }> };
  return r.content[0]!.text;
}

describe("任务会话与 @ 引入", () => {
  it("建任务就有且只有一段会话", () => {
    const t = createTask({ title: "有会话", kind: "verbal", source: {} });
    expect(t.source.conversationId).toBeTruthy();
    expect(conversationExists(t.source.conversationId!)).toBe(true);
  });

  it("@ 列出 worktree 里的文件、资料、截图；选文件变成附件", async () => {
    const wt = mkdtempSync(join(tmpdir(), "app-feat-mention-"));
    execFileSync("git", ["init", "-q", wt]);
    writeFileSync(join(wt, "useExportJob.ts"), "export const x = 1;\n");
    execFileSync("git", ["-C", wt, "add", "."]);
    const t = createTask({ title: "引入", kind: "verbal", source: { worktree: wt } });
    const list = (await (await app.request(`/tasks/${t.id}/mentions?q=export`)).json()) as Array<{ kind: string; label: string; ref: string }>;
    expect(list).toContainEqual({ kind: "file", label: "useExportJob.ts", ref: "useExportJob.ts" });
    const r = (await (await mention(t.id, { kind: "file", ref: "useExportJob.ts" })).json()) as { attachmentId?: string };
    expect(r.attachmentId).toBeTruthy();
  });

  it("引入的文件不能逃出 worktree", async () => {
    const wt = mkdtempSync(join(tmpdir(), "app-feat-escape-"));
    const t = createTask({ title: "越界", kind: "verbal", source: { worktree: wt } });
    const res = await mention(t.id, { kind: "file", ref: "../../etc/passwd" });
    expect(res.status).toBe(400);
    expect(getTask(t.id)).toBeTruthy();
  });

  it("目录、超过 1MB、二进制文件都不引入", async () => {
    const wt = mkdtempSync(join(tmpdir(), "app-feat-big-"));
    mkdirSync(join(wt, "src"));
    writeFileSync(join(wt, "big.log"), Buffer.alloc(1024 * 1024 + 1, 97));
    writeFileSync(join(wt, "blob.bin"), Buffer.from([1, 0, 2, 0, 3]));
    const t = createTask({ title: "太大", kind: "verbal", source: { worktree: wt } });
    for (const ref of ["src", "big.log", "blob.bin"]) {
      const res = await mention(t.id, { kind: "file", ref });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/[一-龥]/);
    }
  });
});

describe("存量任务补会话", () => {
  it("没收工、没会话的各补一段；已收工的不动；再跑一次不多建", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    const ins = d.prepare("INSERT INTO tasks (id, title, kind, source, status, priority, created_at, updated_at) VALUES (?, ?, 'verbal', ?, ?, 'normal', '2026-09-01', '2026-09-01')");
    ins.run("open", "开着", "{}", "understood");
    ins.run("done", "收了", "{}", "done");
    ins.run("bound", "有了", JSON.stringify({ conversationId: "c-1" }), "processing");
    migrate(d);
    migrate(d);
    const conv = (id: string) => (JSON.parse((d.prepare("SELECT source FROM tasks WHERE id = ?").get(id) as { source: string }).source) as { conversationId?: string }).conversationId;
    expect(conv("open")).toBeTruthy();
    expect(d.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conv("open")!)).toBeTruthy();
    expect(conv("done")).toBeUndefined();
    expect(conv("bound")).toBe("c-1");
    expect((d.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n).toBe(1);
  });
});

describe("会话里批准和打回", () => {
  it("打回：待审动作作废、退回处理中、原因进账本", async () => {
    const t = createTask({ title: "打回我", kind: "code", source: { autonomous: true }, status: "review" });
    addPending(t.id, { type: "git_merge", label: "合并分支", detail: "", payload: {} }, { keepStatus: true });
    const out = await callTool(t.source.conversationId, "task_reject", { reason: "中途关页面进度接不上" });
    expect(out).toContain("已打回");
    const after = getTask(t.id)!;
    expect(after.status).toBe("processing");
    expect(after.pending ?? []).toEqual([]);
    expect(listAudit({ taskId: t.id, limit: 20 }).some((e) => e.action === "review_rejected" && e.why === "中途关页面进度接不上")).toBe(true);
  });

  it("会话没绑任务时不执行", async () => {
    expect(await callTool(undefined, "task_approve", {})).toContain("没有绑定任务");
    expect(await callTool("no-such-conv", "task_reject", { reason: "x" })).toContain("没有绑定任务");
  });

  it("Slack 回复没先把原文贴给你就不发", async () => {
    const t = createTask({ title: "回拂晓", kind: "verbal", source: {}, status: "review" });
    addPending(t.id, { type: "slack_reply", label: "回复拂晓", detail: "明天上线", payload: { channel: "D1", text: "明天上线" } }, { keepStatus: true });
    addMessage(t.source.conversationId!, { role: "assistant", kind: "ask", content: "要回吗？" });
    const refused = await callTool(t.source.conversationId, "task_approve", { text: "明天上线" });
    expect(refused).toContain("先把要发的原文");
    expect(getTask(t.id)!.pending).toHaveLength(1);

    addMessage(t.source.conversationId!, { role: "assistant", kind: "ask", content: "要发的是：\n\n明天上线\n\n说「发」我就发。" });
    const tried = await callTool(t.source.conversationId, "task_approve", { text: "明天上线" });
    expect(tried).toContain("Slack 未接入");
    expect(getTask(t.id)!.pending).toHaveLength(1);
  });
});
