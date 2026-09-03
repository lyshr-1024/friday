import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { config } from "../config.js";

export interface Project {
  name: string;
  dir: string;
  status?: string;
  note?: string;
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// projects.md 格式：`## 名称` 下面是 `- 目录：路径` / `- 状态：…` / `- 说明：…`，冒号中英文皆可。
export function parseProjects(markdown: string): Project[] {
  const projects: Project[] = [];
  let current: Project | null = null;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[1]!, dir: "" };
      projects.push(current);
      continue;
    }
    const field = /^-\s*(目录|状态|说明)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (field && current) {
      const [, key, value] = field;
      if (key === "目录") current.dir = expandHome(value!);
      if (key === "状态") current.status = value;
      if (key === "说明") current.note = value;
    }
  }
  return projects.filter((p) => p.dir);
}

export function loadProjects(): Project[] {
  const file = join(config.dataDir, "projects.md");
  return existsSync(file) ? parseProjects(readFileSync(file, "utf8")) : [];
}

export type Resolution = { kind: "match"; project: Project } | { kind: "ambiguous"; candidates: Project[] } | { kind: "none" };

export function resolveProject(query: string, projects = loadProjects()): Resolution {
  const q = query.trim().toLowerCase();
  const exact = projects.find((p) => p.name.toLowerCase() === q);
  if (exact) return { kind: "match", project: exact };

  const partial = projects.filter((p) => p.name.toLowerCase().includes(q) || p.dir.toLowerCase().endsWith(`/${q}`));
  if (partial.length === 1) return { kind: "match", project: partial[0]! };
  if (partial.length > 1) return { kind: "ambiguous", candidates: partial };

  const asPath = expandHome(query.trim());
  if ((asPath.startsWith("/") || query.startsWith("~")) && existsSync(asPath) && statSync(asPath).isDirectory()) {
    return { kind: "match", project: { name: basename(asPath), dir: asPath } };
  }
  return { kind: "none" };
}
