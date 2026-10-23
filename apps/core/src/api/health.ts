import { Hono } from "hono";
import type { HealthResponse } from "@friday/shared";
import { config } from "../config.js";
import { listTools } from "../connectors/registry.js";
import { tmuxVersion } from "../agent/tmux.js";

const startedAt = Date.now();

export const health = new Hono().get("/health", async (c) => {
  const body: HealthResponse = {
    ok: true,
    version: config.version,
    uptimeMs: Date.now() - startedAt,
    tmux: (await tmuxVersion()) ?? null,
    tools: listTools().flatMap((t) => (t.health ? [{ name: t.name, ok: t.health.ok, at: t.health.at, ...(t.health.error ? { error: t.health.error } : {}) }] : [])),
  };
  return c.json(body);
});
