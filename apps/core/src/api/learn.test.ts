import { describe, expect, it } from "vitest";
import { app } from "./index.js";
import { addLesson } from "../memory/lessons.js";
import { GATE_CATEGORIES, getThreshold } from "../memory/thresholds.js";
import type { LearnStats } from "@friday/shared";

describe("GET /learn", () => {
  it("每个类别一行，带阈值、通过率、lesson 数", async () => {
    addLesson({ category: "question", kind: "approved", confidence: 95 });
    addLesson({ category: "question", kind: "rejected", confidence: 60 });
    const rows = (await (await app.request("/learn")).json()) as LearnStats[];
    expect(rows).toHaveLength(GATE_CATEGORIES.length);
    expect(rows.map((r) => r.category)).toContain("autostart");
    const q = rows.find((r) => r.category === "question")!;
    expect(q.lessons).toBe(2);
    expect(q.approved).toBe(1);
    expect(q.threshold).toBeGreaterThan(0);
  });
});

describe("PUT /learn/threshold", () => {
  it("改得动，越界被钳住", async () => {
    const res = await app.request("/learn/threshold", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "notice", value: 75 }) });
    expect(res.status).toBe(200);
    expect(getThreshold("notice")).toBe(75);
    await app.request("/learn/threshold", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "notice", value: 999 }) });
    expect(getThreshold("notice")).toBe(100);
  });

  it("类别非法返回 400", async () => {
    const res = await app.request("/learn/threshold", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "bogus", value: 80 }) });
    expect(res.status).toBe(400);
  });
});
