import { z } from "zod";
import { untrusted } from "../../agent/fence.js";
import { defineBuiltin } from "../builtin.js";
import { implementRole } from "../roles.js";
import { docExcerpt, fetchLarkDoc, fetchLarkTitle, ownsLarkUrl } from "./index.js";

defineBuiltin({
  name: "lark",
  scenario: "读飞书 / Lark 云文档正文（PRD、技术方案）",
  roles: ["docs"],
  binaries: ["lark-cli"],
  ops: [{
    name: "read",
    description: "读飞书 / Lark 云文档，返回标题、大纲和正文节选",
    input: { url: z.string().url() },
    level: "read",
    async run(args) {
      const doc = await fetchLarkDoc(String(args.url), { timeoutMs: 15_000 });
      if (!doc) throw new Error("没读到文档（lark-cli 没登录或没权限）");
      return { text: untrusted("飞书文档", docExcerpt(doc, undefined, 8000)) };
    },
  }],
});

implementRole("docs", "lark", {
  owns: ownsLarkUrl,
  read: (url, opts) => fetchLarkDoc(url, opts),
  excerpt: docExcerpt,
  title: fetchLarkTitle,
});
