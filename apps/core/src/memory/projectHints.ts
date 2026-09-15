import { readMemoryFile, writeMemoryFile } from "./files.js";
import { loadProjects } from "./projects.js";

/**
 * 用户答完「这条工单是哪个项目的」之后，把线索沉淀进 projects.md，下次同类工单自动归。
 * 沉淀的是别名（标题里的方括号标记）和地址前缀（页面链接的域名段）——都是 matchProject /
 * matchProjectByUrl 已经在用的东西，写进去立刻生效，用户也能在文件里看到和改。
 */

/** 工单标题里的【BO】【WBO-0907集成】这类标记，是归项目最稳的线索。 */
export function titleTags(title: string): string[] {
  return [...title.matchAll(/[【\[]([^】\]]{2,20})[】\]]/g)]
    .map((m) => m[1]!.trim())
    // 带日期或流水号的是一次性的（【WBO-0907集成】），留着会越攒越多
    .filter((t) => t.length >= 2 && !/\d{3,}/.test(t));
}

/** 页面链接里可复用的前缀：域名 + 第一段路径。 */
export function urlPrefix(url: string): string | undefined {
  const m = /^https?:\/\/([^/?#]+)(\/[^/?#]+)?/i.exec(url.trim());
  if (!m) return undefined;
  const host = m[1]!.toLowerCase().replace(/^www\./, "");
  const seg = m[2]?.toLowerCase() ?? "";
  // 单段路径才有区分意义，太深的是具体页面
  return seg && !/\.\w+$/.test(seg) ? `${host}${seg}` : host;
}

export interface HintResult {
  added: { aliases: string[]; urls: string[] };
  changed: boolean;
}

/**
 * 往 projects.md 里某个项目补别名和地址。整篇读改写，保持原格式。
 * 已经有的不重复加；项目不存在就什么都不做（不要凭空造一节）。
 */
export function addProjectHints(project: string, hints: { aliases?: string[]; urls?: string[] }): HintResult {
  const md = readMemoryFile("projects");
  const lines = md.split("\n");
  const head = lines.findIndex((l) => new RegExp(`^##\\s+${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(l));
  if (head === -1) return { added: { aliases: [], urls: [] }, changed: false };
  let end = lines.findIndex((l, i) => i > head && /^##\s+/.test(l));
  if (end === -1) end = lines.length;

  const current = loadProjects().find((p) => p.name === project);
  const have = new Set([...(current?.aliases ?? []), ...(current?.urls ?? [])].map((s) => s.toLowerCase()));
  const aliases = [...new Set(hints.aliases ?? [])].filter((a) => a && !have.has(a.toLowerCase()));
  const urls = [...new Set(hints.urls ?? [])].filter((u) => u && !have.has(u.toLowerCase()));
  if (!aliases.length && !urls.length) return { added: { aliases: [], urls: [] }, changed: false };

  const patch = (key: "别名" | "地址", add: string[]) => {
    if (!add.length) return;
    const at = lines.findIndex((l, i) => i > head && i < end && new RegExp(`^-\\s*${key}\\s*[:：]`).test(l));
    if (at === -1) {
      // 没有这一行就新建，插在本节最后一条 - 开头的行后面
      let last = head;
      for (let i = head + 1; i < end; i += 1) if (lines[i]!.trim().startsWith("-")) last = i;
      lines.splice(last + 1, 0, `- ${key}：${add.join(", ")}`);
      end += 1;
    } else {
      lines[at] = `${lines[at]!.replace(/\s*$/, "")}, ${add.join(", ")}`;
    }
  };
  patch("别名", aliases);
  patch("地址", urls);
  writeMemoryFile("projects", lines.join("\n"));
  return { added: { aliases, urls }, changed: true };
}

/** 从一条工单里提取可沉淀的线索。 */
export function hintsFrom(title: string, links: string[]): { aliases: string[]; urls: string[] } {
  return {
    aliases: titleTags(title),
    urls: [...new Set(links.map(urlPrefix).filter((u): u is string => Boolean(u)))],
  };
}
