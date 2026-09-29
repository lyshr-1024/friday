import { Hono } from "hono";
import { AUTOSTART_CONFIDENCE } from "@friday/shared";
import { previewAutostart } from "../agent/autostart.js";
import { listTasks } from "../memory/tasks.js";
import { userSettings } from "../settings.js";

export const autostart = new Hono().get("/autostart/preview", (c) => {
  const q = Number(c.req.query("min"));
  const min = Number.isFinite(q) && c.req.query("min") !== undefined && c.req.query("min") !== ""
    ? Math.min(AUTOSTART_CONFIDENCE.max, Math.max(AUTOSTART_CONFIDENCE.min, Math.round(q)))
    : userSettings().autonomousMinConfidence;
  return c.json({ min, ...previewAutostart(listTasks("understood"), min) });
});
