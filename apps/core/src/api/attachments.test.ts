import { describe, expect, it } from "vitest";
import { app } from "./index.js";
import { buildUserContent } from "../agent/content.js";

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("附件", () => {
  it("上传后可按 id 取回，组装消息时图片成 image 块、文本文件内联", async () => {
    const img = (await (await app.request("/attachments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "shot.png", mime: "image/png", data: png1x1 }) })).json()) as { id: string; size: number };
    expect(img.size).toBeGreaterThan(0);
    const got = await app.request(`/attachments/${img.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    const txt = (await (await app.request("/attachments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "notes.md", mime: "text/markdown", data: Buffer.from("# 标题\\n内容").toString("base64") }) })).json()) as { id: string };
    const { content, attached } = buildUserContent("看看这两个", [img.id, txt.id, "00000000-0000-0000-0000-000000000000"]);
    expect(attached.map((a) => a.name)).toEqual(["shot.png", "notes.md"]);
    const blocks = content as Array<{ type: string; text?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["image", "text", "text"]);
    expect(blocks[1]!.text).toContain("notes.md");
    expect(blocks[2]!.text).toBe("看看这两个");
  });

  it("没有附件时 prompt 保持字符串", () => {
    expect(buildUserContent("hi", []).content).toBe("hi");
  });

  it("拒绝空内容", async () => {
    const res = await app.request("/attachments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", mime: "image/png", data: "" }) });
    expect(res.status).toBe(400);
  });
});
