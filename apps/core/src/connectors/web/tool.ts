import { z } from "zod";
import { untrusted } from "../../agent/fence.js";
import { defineBuiltin } from "../builtin.js";
import { implementRole } from "../roles.js";
import { readChunk, type Chunk } from "./index.js";

export function webText(r: Chunk, url: string): string {
  if (r.kind === "login") return `读到的是登录页 / 无权页（${r.url}）：用户 Chrome 里没登录这个站点、登录过期了，或者账号本身没权限。告诉用户先在 Chrome 里打开这个链接确认能看，再让你重读。`;
  const body = untrusted(`网页 ${new URL(r.url).host}`, `标题：${r.title}\n地址：${r.url}\n\n${r.text}`);
  const where = `（第 ${r.from + 1}–${r.from + r.text.length} 字，共 ${r.total} 字）`;
  const rest = r.next !== undefined ? `还没读完，接着读：web_read url=${url} offset=${r.next}` : `读完了${r.truncated ? "（原文超过 10 万字，后面截掉了）" : ""}`;
  // 只写在系统提示里压不住：实测两次读完就说「笔记已存」，research_save 一次没调
  const save = "用户要你学习、记下来的话，读够了就调 research_save 存笔记；没调它、没看到「已存」，就不能说存了。";
  return `${where}\n${body}\n${rest}\n${save}`;
}

defineBuiltin({
  name: "web",
  scenario: "读用户发来的网页、PRD 之外的网页资料；登录态取自用户 Chrome",
  roles: ["web"],
  binaries: [],
  ops: [{
    name: "read",
    description: "用无头浏览器打开一个网页，读回标题和正文（含 iframe 里的），长文分段返回，按结尾的提示带 offset 接着读",
    input: { url: z.string().url().refine((u) => /^https?:\/\//.test(u), "只支持 http / https"), offset: z.number().int().min(0).optional() },
    level: "read",
    async run(args) {
      const url = String(args.url);
      const r = await readChunk(url, typeof args.offset === "number" ? args.offset : 0);
      return { text: webText(r, url), value: r };
    },
  }],
});

implementRole("web", "web", { readChunk: (url, offset) => readChunk(url, offset) });
