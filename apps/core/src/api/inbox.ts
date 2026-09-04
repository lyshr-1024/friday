import { Hono } from "hono";
import type { InboxResponse } from "@friday/shared";
import { listInbox, markInboxDone } from "../memory/inbox.js";
import { drainNotices, state, syncSlackOnce } from "../scheduler/index.js";

export const inbox = new Hono()
  .get("/inbox", (c) => {
    const res: InboxResponse = { items: listInbox(), lastSyncAt: state.lastSyncAt, lastError: state.lastError, configured: state.configured };
    return c.json(res);
  })
  .post("/inbox/sync", async (c) => {
    const added = await syncSlackOnce();
    const res: InboxResponse & { added: number } = { items: listInbox(), lastSyncAt: state.lastSyncAt, lastError: state.lastError, configured: state.configured, added };
    return c.json(res);
  })
  .post("/inbox/:id/done", (c) => (markInboxDone(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "不存在" }, 404)))
  .get("/notifications", (c) => c.json(drainNotices()));
