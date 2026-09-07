import type { Thread } from "@friday/shared";
import { runJson } from "../connectors/exec.js";
import { gitInspect } from "./git.js";
import { readMemoryFile } from "../memory/files.js";
import { resolveProject } from "../memory/projects.js";
import { previousBriefs } from "../memory/threads.js";

export interface Enrichment {
  history: string[];
  person?: string;
  links: string[];
  project?: { name: string; dir: string; git: string };
}

const MEEGLE_URL = /https?:\/\/(?:project\.larksuite\.com|project\.feishu\.cn|[a-z0-9-]+\.meegle\.com)\/([a-z0-9_-]+)\/(story|issue|task|[a-z_]+)\/detail\/(\d+)/gi;

const projectKeys = new Map<string, string>();

/** 消息里的 Meegle 工单链接：用本机 meegle CLI 拉标题、状态、优先级、负责人。 */
export async function meegleLookups(text: string, run = runJson): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MEEGLE_URL)) {
    const [, simpleName, , id] = m;
    if (!simpleName || !id || seen.has(id)) continue;
    seen.add(id);
    try {
      let key = projectKeys.get(simpleName);
      if (!key) {
        const res = (await run("meegle", ["project", "search", "--project-key", simpleName, "--format", "json"])) as { projects?: Array<{ project_key: string }> };
        key = res.projects?.[0]?.project_key;
        if (!key) continue;
        projectKeys.set(simpleName, key);
      }
      const item = (await run("meegle", ["workitem", "get", "--work-item-id", id, "--project-key", key, "--fields", "priority", "--format", "json"])) as {
        work_item_attribute?: {
          work_item_name?: string;
          work_item_status?: { name?: string };
          work_item_type?: { name?: string };
          role_members?: Array<{ name?: string; members?: Array<{ name?: string }> }>;
        };
        work_item_fields?: Array<{ key: string; value?: { label?: string } }>;
      };
      const a = item.work_item_attribute;
      if (!a) continue;
      const owner = a.role_members?.find((r) => /assignee|operator|负责/i.test(r.name ?? ""))?.members?.map((x) => x.name).filter(Boolean).join("、");
      const pri = item.work_item_fields?.find((f) => f.key === "priority")?.value?.label;
      out.push(`Meegle ${a.work_item_type?.name ?? ""} #${id}「${a.work_item_name?.trim() ?? ""}」状态 ${a.work_item_status?.name ?? "?"}${pri ? `，${pri}` : ""}${owner ? `，负责人 ${owner}` : ""}`);
    } catch (e) {
      out.push(`Meegle #${id}：查询失败（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return out;
}

/** 从 people.md 里找这个人的条目（按姓名或英文名包含匹配）。 */
export function personNote(userName: string, people = readMemoryFile("people")): string | undefined {
  const tokens = userName
    .replace(/[()（）]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const sections = people.split(/^## /m).slice(1);
  for (const sec of sections) {
    const [title = "", ...rest] = sec.split("\n");
    if (tokens.some((t) => title.toLowerCase().includes(t.toLowerCase()))) {
      return `${title.trim()}：${rest.filter((l) => l.trim()).map((l) => l.replace(/^-\s*/, "").trim()).join("；")}`;
    }
  }
  return undefined;
}

export async function enrichThread(thread: Thread, projectGuess?: string): Promise<Enrichment> {
  const text = thread.items.map((i) => i.text).join("\n");
  const [links, history] = await Promise.all([meegleLookups(text), Promise.resolve(previousBriefs(thread.userId, thread.id))]);
  const person = personNote(thread.userName);
  let project: Enrichment["project"];
  const guess = projectGuess ?? thread.project ?? thread.items.map((i) => i.triage?.project).find(Boolean);
  if (guess) {
    const r = resolveProject(guess);
    if (r.kind === "match") {
      const git = await gitInspect(r.project.dir, "status").catch(() => "");
      project = { name: r.project.name, dir: r.project.dir, git: git.split("\n").slice(0, 4).join("；") };
    }
  }
  return { history, ...(person ? { person } : {}), links, ...(project ? { project } : {}) };
}
