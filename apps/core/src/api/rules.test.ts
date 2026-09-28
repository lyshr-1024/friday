import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Rule } from "@friday/shared";
import { app } from "./index.js";
import { handbookPath } from "../memory/handbooks.js";
import { addRule, getRule } from "../memory/rules.js";

const ev = [{ quote: "原话", at: "2026-09-20T00:00:00Z", kind: "utterance" as const }];
const patch = (id: string, body: unknown) => app.request(`/rules/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("规则接口", () => {
  it("GET /rules?project= 只列在用的", async () => {
    addRule({ project: "api-rules", section: "约定", text: "在用", origin: "history", evidence: ev });
    const res = (await (await app.request("/rules?project=api-rules")).json()) as { rules: Rule[] };
    expect(res.rules.map((r) => r.text)).toEqual(["在用"]);
  });

  it("PATCH 改文字：变成手改，手册重新生成", async () => {
    const r = addRule({ project: "api-rules-2", section: "约定", text: "旧写法", origin: "history", evidence: ev });
    expect((await patch(r.id, { text: "新写法" })).status).toBe(200);
    expect(getRule(r.id)).toMatchObject({ text: "新写法", origin: "manual" });
    expect(readFileSync(handbookPath("api-rules-2"), "utf8")).toContain("新写法");
  });

  it("PATCH 退役要给原因；不给 400", async () => {
    const r = addRule({ project: "api-rules-3", section: "约定", text: "要退役", origin: "history", evidence: ev });
    expect((await patch(r.id, { retire: "" })).status).toBe(400);
    expect((await patch(r.id, { retire: "临时口径" })).status).toBe(200);
    expect(getRule(r.id)).toMatchObject({ status: "retired", retiredWhy: "临时口径" });
    expect(readFileSync(handbookPath("api-rules-3"), "utf8")).not.toContain("要退役");
  });

  it("不存在的规则 404；直接改手册文件的接口没了", async () => {
    expect((await patch("r-00000000", { text: "x" })).status).toBe(404);
    expect((await app.request("/handbooks/api-rules", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) })).status).toBe(404);
  });
});
