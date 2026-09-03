import { describe, expect, it } from "vitest";
import { app } from "./index.js";

describe("CORS", () => {
  it("放行 Tauri WebView 的源", async () => {
    const res = await app.request("/health", { headers: { origin: "http://localhost:1420" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
  });

  it("拒绝其他网页的源", async () => {
    const res = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
