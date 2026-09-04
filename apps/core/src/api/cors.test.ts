import { describe, expect, it } from "vitest";
import { app } from "./index.js";

describe("CORS", () => {
  it("放行 Tauri WebView 的源", async () => {
    const res = await app.request("/health", { headers: { origin: "http://localhost:1420" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
  });

  it("PUT 预检放行（设置页保存记忆库用）", async () => {
    const res = await app.request("/memory/projects", {
      method: "OPTIONS",
      headers: { origin: "tauri://localhost", "access-control-request-method": "PUT", "access-control-request-headers": "content-type" },
    });
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("拒绝其他网页的源", async () => {
    const res = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
