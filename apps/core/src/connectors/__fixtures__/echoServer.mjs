import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1" });
server.tool("echo", "原样返回", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text }] }));
await server.connect(new StdioServerTransport());
