import type { Project } from "../memory/projects.js";
import { matchEnv } from "../memory/projects.js";
import { parseMeegleRef } from "../agent/meegle.js";

/**
 * 浏览器地址栏里的 URL 是哪一类东西。HUD、Slack 消息里的链接、任务卡上的资料三处共用一张表：
 * 认得出的走对应的结构化来源取内容（lark-cli / meegle CLI），认不出的才退到页面 DOM。
 */
export type UrlSource =
  | { kind: "local_dev"; url: string; port: number; path: string }
  | { kind: "lark_doc"; url: string; host: string; docType: string; token: string }
  | { kind: "meegle"; url: string; projectKey: string; workItemId: string }
  | { kind: "gitlab_mr"; url: string; repo: string; mr: string }
  | { kind: "project_page"; url: string; project: string; env?: string; path: string }
  | { kind: "other"; url: string; host: string };

/** 本机 dev server：localhost / 回环地址。局域网 IP 不算——那是别人的机器或容器，本机没有对应进程 */
export const isLocalHost = (host: string) => /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i.test(host);

const LARK_HOST = /(^|\.)(larksuite\.com|feishu\.cn)$/i;
const LARK_PATH = /^\/(docx|wiki|docs|sheets|base|slides|file)\/([A-Za-z0-9]+)/;
const GITLAB_MR = /^(\/.+?)\/-\/merge_requests\/(\d+)/;

export function identifyUrl(raw: string | undefined, projects: Project[]): UrlSource | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  const url = u.toString();
  const host = u.hostname.toLowerCase();

  if (isLocalHost(host)) {
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return { kind: "local_dev", url, port, path: u.pathname === "/" ? "" : u.pathname };
  }
  if (LARK_HOST.test(host)) {
    const m = LARK_PATH.exec(u.pathname);
    if (m) return { kind: "lark_doc", url, host, docType: m[1]!, token: m[2]! };
  }
  const meegle = parseMeegleRef(url);
  if (meegle) return { kind: "meegle", url, ...meegle };
  const mr = GITLAB_MR.exec(u.pathname);
  if (mr && /gitlab/i.test(host)) return { kind: "gitlab_mr", url, repo: mr[1]!.replace(/^\//, ""), mr: mr[2]! };
  const hit = matchEnv(url, projects);
  if (hit) return { kind: "project_page", url, project: hit.project.name, ...(hit.env ? { env: hit.env } : {}), path: u.pathname === "/" ? "" : u.pathname };
  return { kind: "other", url, host };
}

/** HUD 标题栏那一段：一眼看出 Friday 把眼前这个页认成了什么 */
export function sourceLabel(s: UrlSource, lane?: string): string {
  switch (s.kind) {
    case "local_dev":
      return `本地 :${s.port}`;
    case "lark_doc":
      return s.docType === "wiki" ? "Lark 知识库" : "Lark 文档";
    case "meegle":
      return `Meegle #${s.workItemId}`;
    case "gitlab_mr":
      return `GitLab MR !${s.mr}`;
    case "project_page":
      return `${s.project}${s.env ? ` ${s.env}环境` : ""}${lane ? ` · 泳道 ${lane}` : ""}`;
    case "other":
      return s.host;
  }
}

/** 给模型的一句话：页面是什么、泳道是哪条。模型看不到 URL 结构，这句替它把硬信息摆明。 */
export function sourceLine(s: UrlSource | undefined, lane?: string, localDir?: string): string {
  if (!s) return "";
  switch (s.kind) {
    case "local_dev":
      return `这是本机 dev server（localhost:${s.port}${s.path ? `，路径 ${s.path}` : ""}）${localDir ? `，跑在目录 ${localDir}` : "，没查到是哪个目录在跑"}`;
    case "lark_doc":
      return `这是一篇 Lark ${s.docType === "wiki" ? "知识库页面" : "云文档"}（${s.host}）`;
    case "meegle":
      return `这是 Meegle 工单 #${s.workItemId} 的页面`;
    case "gitlab_mr":
      return `这是 GitLab 仓库 ${s.repo} 的 MR !${s.mr}`;
    case "project_page":
      return `这是项目 ${s.project} 的${s.env ? `${s.env}环境` : ""}页面${lane ? `，泳道 ${lane}（同一域名靠 deploy-env cookie 区分泳道，不要按 URL 猜环境）` : ""}${s.path ? `，路径 ${s.path}` : ""}`;
    case "other":
      return "";
  }
}
