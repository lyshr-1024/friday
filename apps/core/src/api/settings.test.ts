import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "./index.js";

describe("settings", () => {
  it("PUT 更新模型并保留 settings.json 里壳用的 hotkey", async () => {
    const file = join(process.env.FRIDAY_DATA_DIR!, "settings.json");
    writeFileSync(file, JSON.stringify({ hotkey: "Alt+Space" }));
    const res = await app.request("/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5" }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe("claude-sonnet-5");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hotkey: "Alt+Space", model: "claude-sonnet-5" });
  });

  it("拒绝未知模型", async () => {
    const res = await app.request("/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-9" }) });
    expect(res.status).toBe(400);
  });
});
