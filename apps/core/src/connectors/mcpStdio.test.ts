import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { callStdio, listStdioTools } from "./mcpStdio.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "echoServer.mjs");
let file = "";

beforeAll(() => {
  file = join(mkdtempSync(join(tmpdir(), "mcp-stdio-")), "claude.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [fixture] }, web: { type: "http", url: "http://x" } } }));
});

describe("stdio MCP 客户端", () => {
  it("列出工具", async () => {
    const tools = await listStdioTools("echo", file);
    expect(tools.map((t) => t.name)).toContain("echo");
    expect(tools.find((t) => t.name === "echo")!.description).toBe("原样返回");
  });
  it("调用工具", async () => {
    expect(await callStdio("echo", "echo", { text: "hi" }, file)).toEqual({ text: "hi", isError: false });
  });
  it("工具报错透传 isError", async () => {
    expect((await callStdio("echo", "echo", {}, file)).isError).toBe(true);
  });
  it("不是 stdio 的拒掉", async () => {
    await expect(callStdio("web", "x", {}, file)).rejects.toThrow(/stdio/);
  });
});
