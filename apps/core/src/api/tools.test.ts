import { describe, expect, it } from "vitest";
import "../connectors/web/tool.js";
import { seedBuiltins } from "../connectors/builtin.js";
import { listAudit } from "../memory/audit.js";
import { tools } from "./tools.js";

describe("/tools", () => {
  it("PATCH 开关记账，GET 带等级计数", async () => {
    seedBuiltins();
    const res = await tools.request("/tools/web", { method: "PATCH", body: JSON.stringify({ enabled: false }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const list = (await (await tools.request("/tools")).json()) as { tools: Array<{ name: string; enabled: boolean; counts: Record<string, number> }> };
    const web = list.tools.find((t) => t.name === "web")!;
    expect(web.enabled).toBe(false);
    expect(Object.keys(web.counts).sort()).toEqual(["irreversible", "read", "reversible", "unset"]);
    expect(listAudit({ limit: 1 })[0]?.action).toBe("tool_updated");
    expect((await tools.request("/tools/nope", { method: "PATCH", body: JSON.stringify({ enabled: true }), headers: { "content-type": "application/json" } })).status).toBe(404);
  });
});
