import { z } from "zod";
import { untrusted } from "../../agent/fence.js";
import { defineBuiltin } from "../builtin.js";
import { implementRole } from "../roles.js";
import { docExcerpt, fetchLarkDoc, fetchLarkTitle, ownsLarkUrl, type LarkDoc } from "./index.js";

/** 同 web read：一次返回超过 MCP 输出上限会被转存成文件，终端里的 Claude 读不到 */
const CHUNK = 20_000;

export function larkText(doc: LarkDoc, url: string, offset: number): string {
  const head = [doc.title ? `标题：${doc.title}` : "", doc.outline.length ? `大纲：${doc.outline.join(" / ")}` : ""].filter(Boolean).join("\n");
  const from = Math.min(offset, doc.text.length);
  const body = doc.text.slice(from, from + CHUNK);
  const next = from + body.length < doc.text.length ? from + body.length : undefined;
  const where = `（第 ${from + 1}–${from + body.length} 字，共 ${doc.text.length} 字）`;
  const rest = next !== undefined ? `还没读完，接着读：tool_call lark read url=${url} offset=${next}` : "读完了";
  return `${where}\n${untrusted("飞书文档", [from === 0 ? head : "", body].filter(Boolean).join("\n"))}\n${rest}`;
}

defineBuiltin({
  name: "lark",
  scenario: "读飞书 / Lark 云文档正文（PRD、技术方案）",
  roles: ["docs"],
  binaries: ["lark-cli"],
  ops: [{
    name: "read",
    description: "读飞书 / Lark 云文档，返回标题、大纲和正文；长文分段返回，按结尾的提示带 offset 接着读",
    input: {
      url: z.string().url().refine((u) => /^https?:\/\//.test(u) && ownsLarkUrl(u), "只认飞书 / Lark 文档的 http(s) 地址"),
      offset: z.number().int().min(0).optional(),
    },
    level: "read",
    async run(args) {
      const url = String(args.url);
      const doc = await fetchLarkDoc(url, { timeoutMs: 15_000 });
      if (!doc) throw new Error("没读到文档（lark-cli 没登录或没权限）");
      return { text: larkText(doc, url, typeof args.offset === "number" ? args.offset : 0) };
    },
  }],
});

implementRole("docs", "lark", {
  owns: ownsLarkUrl,
  read: (url, opts) => fetchLarkDoc(url, opts),
  excerpt: docExcerpt,
  title: fetchLarkTitle,
});
