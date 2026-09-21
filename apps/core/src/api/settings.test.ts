import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SUMMON_SETTINGS, type SettingsResponse } from "@friday/shared";
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

  it("skills 开关可读写，默认开", async () => {
    const before = (await (await app.request("/settings")).json()) as { skills: boolean };
    expect(before.skills).toBe(true);
    const res = await app.request("/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ skills: false }) });
    expect(((await res.json()) as { skills: boolean }).skills).toBe(false);
  });

  it("拒绝未知模型", async () => {
    const res = await app.request("/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-9" }) });
    expect(res.status).toBe(400);
  });

  it("summon 设置有默认值，PUT 只合并传进来的字段", async () => {
    const before = await app.request("/settings");
    expect(((await before.json()) as SettingsResponse).summon).toEqual(DEFAULT_SUMMON_SETTINGS);

    const res = await app.request("/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summon: { screenshotFallback: false } }),
    });
    const after = (await res.json()) as SettingsResponse;
    expect(after.summon.screenshotFallback).toBe(false);
    expect(after.summon.urlAllowlist).toEqual(DEFAULT_SUMMON_SETTINGS.urlAllowlist);
  });

  // 白名单是并集：存过一次之后代码里新加的默认域名还得能进来，
  // 否则「加了默认值却不生效」——larksuite 就是这么漏掉的
  it("自定义白名单不会顶掉后来新增的默认域名", async () => {
    await app.request("/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summon: { urlAllowlist: ["my.internal.site"] } }),
    });
    const res = await app.request("/settings");
    const got = ((await res.json()) as SettingsResponse).summon.urlAllowlist;
    expect(got).toContain("my.internal.site");
    for (const d of DEFAULT_SUMMON_SETTINGS.urlAllowlist) expect(got).toContain(d);
  });
});
