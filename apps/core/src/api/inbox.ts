import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { InboxResponse, RunResponse } from "@friday/shared";
import { jobLog, launchClaude } from "../agent/runner.js";
import { createJob } from "../memory/jobs.js";
import { getInboxItem, listInbox, markInboxDone } from "../memory/inbox.js";
import { resolveProject } from "../memory/projects.js";
import { drainNotices, state, syncSlackOnce } from "../scheduler/index.js";
import { userSettings } from "../settings.js";

/** 把一条 Slack 消息交给对应项目里的 Claude Code：摘要 + 原文 + 链接一起带过去。 */
export function handoffTask(item: NonNullable<ReturnType<typeof getInboxItem>>): string {
  const head = item.triage?.task ?? item.triage?.summary ?? "处理这条 Slack 消息";
  return `${head}\n\n来源 Slack：${item.userName} 在 ${item.channelName} 说：\n${item.text}${item.permalink ? `\n${item.permalink}` : ""}`;
}

export const inbox = new Hono()
  .get("/inbox", (c) => {
    const res: InboxResponse = { items: listInbox(), lastSyncAt: state.lastSyncAt, nextSyncAt: state.nextSyncAt, lastError: state.lastError, configured: state.configured };
    return c.json(res);
  })
  .post("/inbox/sync", async (c) => {
    const added = await syncSlackOnce();
    const res: InboxResponse & { added: number } = { items: listInbox(), lastSyncAt: state.lastSyncAt, nextSyncAt: state.nextSyncAt, lastError: state.lastError, configured: state.configured, added };
    return c.json(res);
  })
  .post("/inbox/:id/done", (c) => (markInboxDone(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "不存在" }, 404)))
  .post("/inbox/:id/handle", async (c) => {
    const item = getInboxItem(c.req.param("id"));
    if (!item) return c.json({ error: "不存在" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { project?: string };
    const query = body.project ?? item.triage?.project;
    if (!query) return c.json({ error: "这条消息没推导出项目，请指定" }, 400);
    const resolved = resolveProject(query);
    if (resolved.kind === "none") return c.json({ error: `没找到项目「${query}」` }, 404);
    if (resolved.kind === "ambiguous") {
      const res: RunResponse = { status: "ambiguous", candidates: resolved.candidates.map((p) => ({ name: p.name, dir: p.dir })) };
      return c.json(res);
    }
    const { terminal } = userSettings();
    const task = handoffTask(item);
    const id = randomUUID();
    await launchClaude({ id, dir: resolved.project.dir, terminal, task });
    createJob({ id, project: resolved.project.name, dir: resolved.project.dir, task, logPath: jobLog(id) });
    const res: RunResponse = { status: "launched", project: resolved.project.name, dir: resolved.project.dir, terminal, task, jobId: id };
    return c.json(res);
  })
  .get("/notifications", (c) => c.json(drainNotices()))
  // 设置页「测试通知」：塞一条进队列，壳 20 秒内取走弹出；弹不出来就是系统通知权限问题。
  .post("/notifications/test", (c) => {
    state.notices.push({ title: "Friday 测试通知", body: `通知链路正常 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` });
    return c.json({ ok: true });
  });
