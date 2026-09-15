import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { config } from "../config.js";

export interface Project {
  name: string;
  dir: string;
  aliases: string[];
  channels: string[];
  /** 这个项目对外的地址前缀（host 或 host/路径段），用来把工单里的页面链接归到项目 */
  urls: string[];
  status?: string;
  note?: string;
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// projects.md 格式：`## 名称` 下面是 `- 目录：路径` / `- 别名：a, b` / `- 频道：#a, #b` / `- 状态：…` / `- 说明：…`，冒号中英文皆可。
export function parseProjects(markdown: string): Project[] {
  const projects: Project[] = [];
  let current: Project | null = null;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[1]!, dir: "", aliases: [], channels: [], urls: [] };
      projects.push(current);
      continue;
    }
    const field = /^-\s*(目录|别名|频道|地址|状态|说明)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (field && current) {
      const [, key, value] = field;
      if (key === "目录") current.dir = expandHome(value!);
      if (key === "别名") current.aliases = value!.split(/[,，、\s]+/).filter(Boolean);
      if (key === "频道") current.channels = value!.split(/[,，、\s]+/).filter(Boolean).map((c) => (c.startsWith("#") ? c : `#${c}`));
      if (key === "地址") current.urls = value!.split(/[,，、\s]+/).filter(Boolean).map(normalizeUrlPrefix);
      if (key === "状态") current.status = value;
      if (key === "说明") current.note = value;
    }
  }
  return projects.filter((p) => p.dir);
}

/** 「https://console.longbridge.xyz/wbo/」→「console.longbridge.xyz/wbo」，比对时两边都走这一步。 */
export function normalizeUrlPrefix(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

/**
 * 按工单里的页面链接归项目：谁的地址前缀匹配得更长谁赢。
 * 迁移期同一个域名下新旧两套并存，所以带路径段的前缀（console.x/wbo）要能压过光域名的（console.x）。
 */
export function matchProjectByUrl(urls: string[], projects: Project[]): Project | undefined {
  let best: { project: Project; len: number } | undefined;
  for (const raw of urls) {
    const target = normalizeUrlPrefix(raw);
    for (const project of projects) {
      for (const prefix of project.urls) {
        if (!prefix) continue;
        // 前缀要落在路径边界上，免得 console.x/wbo 命中 console.x/wbotest
        if (target !== prefix && !target.startsWith(`${prefix}/`)) continue;
        if (!best || prefix.length > best.len) best = { project, len: prefix.length };
      }
    }
  }
  return best?.project;
}

export function loadProjects(): Project[] {
  const file = join(config.dataDir, "projects.md");
  return existsSync(file) ? parseProjects(readFileSync(file, "utf8")) : [];
}

export type Resolution = { kind: "match"; project: Project } | { kind: "ambiguous"; candidates: Project[] } | { kind: "none" };

export function resolveProject(query: string, projects = loadProjects()): Resolution {
  const q = query.trim().toLowerCase();
  const exact = projects.find((p) => p.name.toLowerCase() === q || p.aliases.some((a) => a.toLowerCase() === q));
  if (exact) return { kind: "match", project: exact };

  const partial = projects.filter(
    (p) => p.name.toLowerCase().includes(q) || p.dir.toLowerCase().endsWith(`/${q}`) || p.aliases.some((a) => a.toLowerCase().includes(q)),
  );
  if (partial.length === 1) return { kind: "match", project: partial[0]! };
  if (partial.length > 1) return { kind: "ambiguous", candidates: partial };

  const asPath = expandHome(query.trim());
  if ((asPath.startsWith("/") || query.startsWith("~")) && existsSync(asPath) && statSync(asPath).isDirectory()) {
    return { kind: "match", project: { name: basename(asPath), dir: asPath, aliases: [], channels: [], urls: [] } };
  }
  return { kind: "none" };
}
