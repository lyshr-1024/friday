import { Hono } from "hono";
import type { SettingsResponse } from "@friday/shared";
import { config } from "../config.js";
import { loadProjects } from "../memory/projects.js";
import { userSettings } from "../settings.js";

export const settings = new Hono().get("/settings", (c) => {
  const res: SettingsResponse = { ...userSettings(), dataDir: config.dataDir, projects: loadProjects().map((p) => (p.aliases.length ? `${p.name}（${p.aliases.join(" / ")}）` : p.name)) };
  return c.json(res);
});
