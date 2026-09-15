import { Hono } from "hono";
import { z } from "zod";
import { REPLY_CATEGORY_LABEL, REPLY_CATEGORIES, type LearnStats, type ReplyCategory } from "@friday/shared";
import { stats, suggest, WINDOW } from "../agent/gate.js";
import { listLessons } from "../memory/lessons.js";
import { allThresholds, setThreshold } from "../memory/thresholds.js";
import { record } from "../memory/audit.js";

const body = z.object({ category: z.enum(REPLY_CATEGORIES as [ReplyCategory, ...ReplyCategory[]]), value: z.number().int() });

function rows(): LearnStats[] {
  const thresholds = allThresholds();
  return REPLY_CATEGORIES.map((category) => {
    const s = stats(listLessons(category, WINDOW));
    const suggested = suggest(thresholds[category], s);
    return {
      category,
      label: REPLY_CATEGORY_LABEL[category],
      threshold: thresholds[category],
      ...(suggested !== undefined ? { suggested } : {}),
      lessons: s.total,
      approved: s.approved,
      calibrationError: Math.round(s.calibrationError),
    };
  });
}

export const learn = new Hono()
  .get("/learn", (c) => c.json(rows()))
  .put("/learn/threshold", async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "类别或数值不合法" }, 400);
    const before = allThresholds()[parsed.data.category];
    setThreshold(parsed.data.category, parsed.data.value);
    record({ action: "threshold_changed", why: "你手动改了阈值", how: `${parsed.data.category} ${before} → ${allThresholds()[parsed.data.category]}`, evidence: { category: parsed.data.category, before }, risk: "reversible" });
    return c.json(rows());
  });
