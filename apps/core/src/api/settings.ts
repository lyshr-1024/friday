import { Hono } from "hono";
import { z } from "zod";
import { MODEL_OPTIONS, THEME_OPTIONS, type SettingsResponse } from "@friday/shared";
import { config } from "../config.js";
import { loadProjects } from "../memory/projects.js";
import { updateSettings, userSettings } from "../settings.js";

const patch = z.object({
  terminal: z.enum(["embedded", "ghostty", "terminal"]).optional(),
  model: z.enum(MODEL_OPTIONS.map((m) => m.id) as [string, ...string[]]).optional(),
  skills: z.boolean().optional(),
  name: z.string().max(40).optional(),
  theme: z.enum(THEME_OPTIONS.map((t) => t.id) as [string, ...string[]]).optional(),
  learn: z.boolean().optional(),
  learnHistory: z.boolean().optional(),
  summon: z.object({
    screenshotFallback: z.boolean().optional(),
    urlAllowlist: z.array(z.string()).optional(),
  }).optional(),
});

function respond(): SettingsResponse {
  return {
    ...userSettings(),
    dataDir: config.dataDir,
    projects: loadProjects().map((p) => (p.aliases.length ? `${p.name}（${p.aliases.join(" / ")}）` : p.name)),
  };
}

export const settings = new Hono()
  .get("/settings", (c) => c.json(respond()))
  .put("/settings", async (c) => {
    const parsed = patch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "无效的设置项" }, 400);
    updateSettings(parsed.data as Parameters<typeof updateSettings>[0]);
    return c.json(respond());
  });
