import { describe, expect, it } from "vitest";
import type { RunsSummary } from "@friday/shared";
import { app } from "./index.js";
import { createRun, finishRun, setRunOutcome } from "../memory/runs.js";

describe("GET /runs/summary", () => {
  it("按项目 + 类型汇总；range 不认识的回落到 30 天", async () => {
    createRun({ id: "api-r1", jobId: "api-r1", taskId: "t", project: "api-proj", kind: "autonomous", trigger: "retry" });
    finishRun("api-r1", { exit: "report", costUsd: 0.8 });
    setRunOutcome("api-r1", "merged_as_is");
    const res = await app.request("/runs/summary?range=bogus");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsSummary;
    expect(body.range).toBe("30d");
    expect(body.byProject.find((p) => p.project === "api-proj")).toMatchObject({ kind: "autonomous", runs: 1, mergedAsIs: 1, costUsd: 0.8 });
  });
});
