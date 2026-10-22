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
  /** 环境名由用户自己起（线上/测试/SIT/UAT…），代码不做关键字校验 */
  envs: ProjectEnv[];
  status?: string;
  note?: string;
  /** 守卫不许 Friday 碰的分支（推 / 切过去 / 删），`*` 通配，裸名也盖住 `名/…`；没写用 DEFAULT_PROTECTED */
  protected: string[];
  /** 白名单外的自定义字段原样收着，用户写什么都读得到 */
  extra: Record<string, string>;
}

export interface ProjectEnv {
  name: string;
  url: string;
}

export function isFridayProject(p: Project | string | undefined): boolean {
  const name = typeof p === "string" ? p : p?.name;
  return name?.trim().toLowerCase() === "friday";
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// projects.md 格式：`## 名称` 下面是 `- 键：值`，冒号中英文皆可。目录/别名/频道/地址/环境/状态/说明有各自语义，其余键原样进 extra。
export function parseProjects(markdown: string): Project[] {
  const projects: Project[] = [];
  let current: Project | null = null;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[1]!, dir: "", aliases: [], channels: [], urls: [], envs: [], protected: [], extra: {} };
      projects.push(current);
      continue;
    }
    const field = /^-\s*([^:：]{1,40}?)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (field && current) {
      const key = field[1]!.replace(/\*/g, "");
      const value = field[2]!;
      if (key === "目录") current.dir = expandHome(value);
      // 别名不按空格拆：「Whale 管理后台」拆开会留下「管理后台」这种泛词，命中一切后台工单
      else if (key === "别名") current.aliases = value.split(/[,，、]+/).map((a) => a.trim()).filter(Boolean);
      else if (key === "频道") current.channels = value.split(/[,，、\s]+/).filter(Boolean).map((c) => (c.startsWith("#") ? c : `#${c}`));
      else if (key === "地址") current.urls = value.split(/[,，、\s]+/).filter(Boolean).map(normalizeUrlPrefix);
      else if (key === "环境") current.envs = parseEnvs(value);
      else if (key === "保护分支") current.protected = value.split(/[,，、\s]+/).filter(Boolean);
      else if (key === "状态") current.status = value;
      else if (key === "说明") current.note = value;
      else current.extra[key] = current.extra[key] ? `${current.extra[key]}\n${value}` : value;
    }
  }
  return projects.filter((p) => p.dir);
}

const URLISH = /^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:][^\s，、,]*)?$/i;

/**
 * 「线上 console.x/、测试 console.x/y/」拆成环境名与地址。名字由用户自己起，不做关键字校验。
 * 用户实际写的常是整句话而不是干净的键值对，所以只认「地址前面紧挨着的那个词」，
 * 认不出的部分安静丢掉——不猜比猜错强。
 */
export function parseEnvs(value: string): ProjectEnv[] {
  const clean = (w: string | undefined) => (w && !URLISH.test(w) ? w.replace(/^[（(【]+|[）)】是在于:：]+$/g, "") : "");
  const envs: ProjectEnv[] = [];
  for (const chunk of value.split(/[,，、]+/)) {
    const words = chunk.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (!URLISH.test(words[i]!)) continue;
      // 「SIT 是 console.x」这种，紧挨着的是个虚词，再往前找一个才是名字
      const name = [words[i - 1], words[i - 2]].map(clean).find(Boolean) ?? "";
      const url = normalizeUrlPrefix(words[i]!);
      if (!name || !url) continue;
      envs.push({ name, url });
    }
  }
  return envs;
}

/**
 * 先按环境地址找，找不到才退回项目的 `urls`，老配置照常工作。
 * 同样前缀最长优先：两个项目共用域名时带路径段的（console.x/x）要压过光域名的（console.x）。
 */
export function matchEnv(url: string, projects: Project[]): { project: Project; env?: string } | undefined {
  const target = normalizeUrlPrefix(url);
  let best: { project: Project; env: string; len: number } | undefined;
  for (const project of projects) {
    for (const env of project.envs) {
      if (!env.url) continue;
      if (target !== env.url && !target.startsWith(`${env.url}/`)) continue;
      if (!best || env.url.length > best.len) best = { project, env: env.name, len: env.url.length };
    }
  }
  if (best) return { project: best.project, env: best.env };
  const project = matchProjectByUrl([url], projects);
  return project ? { project } : undefined;
}

/** 说明之外用户自己写的字段也一起给出去，否则他写了等于没写。 */
export function projectDetail(p: Project): string {
  return [
    p.note ?? "",
    p.envs.length ? `环境：${p.envs.map((e) => `${e.name} ${e.url}`).join("、")}` : "",
    ...Object.entries(p.extra).map(([k, v]) => `${k}：${v}`),
  ]
    .filter(Boolean)
    .join("\n");
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

/** 主干和常见的环境分支；项目在 projects.md 里写了「保护分支」就整体换成它的 */
export const DEFAULT_PROTECTED = ["main", "master", "develop", "dev", "sit", "uat", "test", "staging", "prod", "production", "release"];

export function protectedBranches(project?: string, projects = loadProjects()): string[] {
  const p = project ? projects.find((x) => x.name === project) : undefined;
  return p?.protected.length ? p.protected : DEFAULT_PROTECTED;
}

export type ProjectFieldKey = "目录" | "别名" | "说明" | "保护分支" | "方案送审" | "环境" | "频道";

function sectionRange(lines: string[], project: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1] === project);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return { start, end };
}

export function projectSection(markdown: string, project: string): string | null {
  const lines = markdown.split("\n");
  const r = sectionRange(lines, project);
  return r ? lines.slice(r.start, r.end).join("\n").trimEnd() : null;
}

/** section 为 null 删掉这一段；段不存在时追加到文件末尾 */
export function replaceProjectSection(markdown: string, project: string, section: string | null): string {
  const lines = markdown.split("\n");
  const r = sectionRange(lines, project);
  if (!r) {
    if (section === null) return markdown;
    const base = markdown.replace(/\n*$/, "");
    return `${base ? `${base}\n\n` : ""}${section}\n`;
  }
  if (section === null) {
    lines.splice(r.start, r.end - r.start);
    return lines.join("\n");
  }
  let contentEnd = r.end;
  while (contentEnd > r.start + 1 && !lines[contentEnd - 1]!.trim()) contentEnd--;
  lines.splice(r.start, contentEnd - r.start, ...section.split("\n"));
  return lines.join("\n");
}

/** 纯文本改写：替换 / 追加 / 删除 `- key：` 行；项目段不存在时在文件末尾新建（必须同时给目录） */
export function setProjectField(markdown: string, project: string, key: ProjectFieldKey, value: string): string {
  const v = value.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1] === project);
  if (start < 0) {
    if (key !== "目录" || !v) throw new Error(`项目「${project}」不存在，新建时必须先给目录`);
    const base = markdown.replace(/\n*$/, "");
    return `${base ? `${base}\n\n` : ""}## ${project}\n- 目录：${v}\n`;
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const isKey = (l: string) => {
    const m = /^-\s*([^:：]{1,40}?)\s*[:：]/.exec(l);
    return !!m && m[1]!.replace(/\*/g, "") === key;
  };
  const hits: number[] = [];
  for (let i = start + 1; i < end; i++) if (isKey(lines[i]!)) hits.push(i);
  if (hits.length) {
    // parseProjects 取最后一行的值（别名 / 频道则各行累加不了），同键多行只留一行才保证改动生效
    if (v) lines[hits[0]!] = `- ${key}：${v}`;
    for (const i of hits.slice(v ? 1 : 0).reverse()) lines.splice(i, 1);
  } else if (v) {
    let last = start;
    for (let i = start + 1; i < end; i++) if (lines[i]!.startsWith("- ")) last = i;
    lines.splice(last + 1, 0, `- ${key}：${v}`);
  }
  return lines.join("\n");
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
    return { kind: "match", project: { name: basename(asPath), dir: asPath, aliases: [], channels: [], urls: [], envs: [], protected: [], extra: {} } };
  }
  return { kind: "none" };
}
