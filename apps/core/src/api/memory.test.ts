import { describe, expect, it } from "vitest";
import { app } from "./index.js";

describe("记忆库文件读写", () => {
  it("写入后可读回，且 /settings 立即按新内容解析项目", async () => {
    const content = "# 项目注册表\n\n## demo\n- 目录：~/demo\n- 别名：演示\n";
    const put = await app.request("/memory/projects", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
    expect(put.status).toBe(200);
    const got = (await (await app.request("/memory/projects")).json()) as { content: string; path: string };
    expect(got.content).toBe(content);
    expect(got.path.endsWith("projects.md")).toBe(true);
    const settings = (await (await app.request("/settings")).json()) as { projects: string[] };
    expect(settings.projects).toEqual(["demo（演示）"]);
  });

  it("拒绝白名单外的文件名", async () => {
    expect((await app.request("/memory/../etc")).status).toBe(404);
    expect((await app.request("/memory/todos")).status).toBe(404);
  });
});
