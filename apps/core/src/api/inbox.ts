import { Hono } from "hono";
import type { InboxResponse } from "@friday/shared";
import { listInbox, markInboxDone } from "../memory/inbox.js";
import { drainNotices, state, syncSlackOnce } from "../scheduler/index.js";

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
  .get("/notifications", (c) => c.json(drainNotices()))
  // 设置页「测试通知」：塞一条进队列，壳 20 秒内取走弹出；弹不出来就是系统通知权限问题。
  .post("/notifications/test", (c) => {
    state.notices.push({ title: "Friday 测试通知", body: `通知链路正常 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` });
    return c.json({ ok: true });
  });
