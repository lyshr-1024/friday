import { Hono } from "hono";
import type { HealthResponse } from "@friday/shared";
import { config } from "../config.js";

const startedAt = Date.now();

export const health = new Hono().get("/health", (c) => {
  const body: HealthResponse = {
    ok: true,
    version: config.version,
    uptimeMs: Date.now() - startedAt,
  };
  return c.json(body);
});
