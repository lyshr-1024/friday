import { Hono } from "hono";
import type { UsageRange } from "@friday/shared";
import { usageSummary } from "../memory/usage.js";

const RANGES: UsageRange[] = ["today", "7d", "30d"];

export const usage = new Hono().get("/usage", (c) => {
  const q = c.req.query("range") as UsageRange | undefined;
  return c.json(usageSummary(q && RANGES.includes(q) ? q : "today"));
});
