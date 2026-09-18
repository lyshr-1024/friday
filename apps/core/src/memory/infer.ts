import type { LinkNode, Task } from "@friday/shared";
import { linkUp } from "./links.js";
import { loadProjects, matchProjectByUrl, normalizeUrlPrefix } from "./projects.js";

export const taskNode = (id: string): LinkNode => ({ kind: "task", ref: id });
export const meegleNode = (id: string): LinkNode => ({ kind: "meegle", ref: id });
export const threadNode = (id: string): LinkNode => ({ kind: "thread", ref: id });
export const projectNode = (name: string): LinkNode => ({ kind: "project", ref: name });
/** 分支要带项目名：不同仓库里同名的 main / feat/x 不是一条分支 */
export const branchNode = (project: string, branch: string): LinkNode => ({ kind: "branch", ref: `${project}:${branch}` });
export const urlNode = (url: string): LinkNode => ({ kind: "url", ref: normalizeUrlPrefix(url) });

/** 工单号：链接里的 /detail/24440539，或裸的 8 位以上数字 */
const MEEGLE_URL = /project\.(?:larksuite|feishu)\.com\/[^\s)]*?\/(?:detail|issue|story)\/(\d{6,})/gi;
const TICKET_IN_TEXT = /\b(\d{8})\b/g;

export function meegleIdsIn(text: string): string[] {
  if (!text) return [];
  const ids = new Set<string>();
  for (const m of text.matchAll(MEEGLE_URL)) if (m[1]) ids.add(m[1]);
  for (const m of text.matchAll(TICKET_IN_TEXT)) if (m[1]) ids.add(m[1]);
  return [...ids];
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'）)】]+/g;
// 中英文句读都可能紧跟在链接后面，一起剥掉
const TAIL_PUNCT = /[.,;:!?。，、；：！？]+$/;

export function urlsIn(text: string): string[] {
  return text ? [...new Set((text.match(URL_IN_TEXT) ?? []).map((u) => u.replace(TAIL_PUNCT, "")))] : [];
}

/**
 * 一条任务能推出来的所有关联，全走确定性规则——
 * 分支、工单号、页面地址、项目，四样都是查表查出来的，不调模型。
 * 返回记下了几条，调用方拿去写日志。
 */
export function inferTaskLinks(task: Task): number {
  const me = taskNode(task.id);
  const src = task.source;
  let n = 0;
  const add = (other: LinkNode, why: string) => {
    if (linkUp(me, other, "rule", why)) n += 1;
  };

  // ① 分支：终端开工时记的，是关联里最硬的一条线索
  const project = task.project ?? "";
  if (src.branch && project) add(branchNode(project, src.branch), `终端在 ${project} 的 ${src.branch} 上干这条任务`);
  if (project) add(projectNode(project), "任务归属的项目");

  // ② 工单：自己是工单，或挂在某个需求下
  if (src.meegleId) add(meegleNode(src.meegleId), "这条任务就是这个工单");
  if (src.linkedStoryId) add(meegleNode(src.linkedStoryId), `缺陷挂在需求 ${src.linkedStoryName ?? src.linkedStoryId} 下`);

  // ③ Slack 线程
  if (src.threadId) add(threadNode(src.threadId), "这条任务是从这个 Slack 线程来的");

  // ④ 正文里提到的工单号和页面地址。source.note 是口头交代的原话，
  //    source.description 是 Meegle 缺陷正文——复现步骤里的环境地址就在那儿，漏了等于白做
  const text = [task.title, task.understanding, task.plan, task.progress, src.note, src.description].filter(Boolean).join("\n");
  for (const id of meegleIdsIn(text)) if (id !== src.meegleId) add(meegleNode(id), "任务正文里提到了这个工单号");
  const projects = loadProjects();
  for (const url of urlsIn(text)) {
    add(urlNode(url), "任务正文里提到了这个页面");
    const hit = matchProjectByUrl([url], projects);
    if (hit && hit.name !== project) add(projectNode(hit.name), `页面地址 ${url} 属于 ${hit.name}`);
  }
  return n;
}

/**
 * 你在浏览器里打开的页面 → 哪个项目。
 * 纯前缀匹配，最长的赢（/x/ 比 / 长，所以 whale-console 压过 fe-wealth-admin）。
 */
export function projectOfUrl(url: string): string | undefined {
  return matchProjectByUrl([url], loadProjects())?.name;
}
