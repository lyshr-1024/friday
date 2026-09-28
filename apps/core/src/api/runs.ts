import { Hono } from "hono";
import type { UsageRange } from "@friday/shared";
import { runsSummary } from "../memory/runs.js";

const RANGES: UsageRange[] = ["today", "7d", "30d"];

export const runs = new Hono().get("/runs/summary", (c) => {
  const q = c.req.query("range") as UsageRange | undefined;
  return c.json(runsSummary(q && RANGES.includes(q) ? q : "30d"));
});
