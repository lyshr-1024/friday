import { conversationOf, workItemOf, type LinkNode, type LinkSource, type Task } from "@friday/shared";
import { extNode, linkUp, neighbors } from "./links.js";
import { loadProjects, matchProjectByUrl, normalizeUrlPrefix } from "./projects.js";
import { idsIn as workItemIdsIn } from "../connectors/meegle/rules.js";
import { linkType as slackLinkType } from "../connectors/slack/ref.js";

export const taskNode = (id: string): LinkNode => ({ kind: "task", ref: id });
export const projectNode = (name: string): LinkNode => ({ kind: "project", ref: name });
/** 分支要带项目名：不同仓库里同名的 main / feat/x 不是一条分支 */
export const branchNode = (project: string, branch: string): LinkNode => ({ kind: "branch", ref: `${project}:${branch}` });
export const urlNode = (url: string): LinkNode => ({ kind: "url", ref: normalizeUrlPrefix(url) });
export { extNode };

/** 跟 node 相连的某个工具某种东西，ref 去掉「工具:类型:」前缀只留 id */
export function extNeighbors(node: LinkNode, tool: string, type: string): Array<{ ref: string; source: LinkSource; why: string }> {
  const prefix = `${tool}:${type}:`;
  return neighbors(node, "ext")
    .filter((n) => n.ref.startsWith(prefix))
    .map((n) => ({ ...n, ref: n.ref.slice(prefix.length) }));
}

export { conversationKey } from "@friday/shared";

const URL_IN_TEXT = /https?:\/\/[^\s<>"'）)】]+/g;
// 中英文句读都可能紧跟在链接后面，一起剥掉
const TAIL_PUNCT = /[.,;:!?。，、；：！？]+$/;

/** 建任务标题用：把 `<@U…>` 这类 Slack 标记去掉——「<@U092UA21P6D> 这个优化一下」当标题谁都读不懂 */
export function withoutMentions(text: string): string {
  return text.replace(/<[@!][^>]*>/g, "").replace(/\s{2,}/g, " ").trim();
}

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
  const work = workItemOf(src);
  if (work) add(extNode(work.tool, work.type, work.id), "这条任务就是这个工单");
  if (work?.parent) add(extNode(work.tool, work.type, work.parent.id), `缺陷挂在需求 ${work.parent.name ?? work.parent.id} 下`);

  // ③ 老库遗留的 Slack 线程
  const conv = conversationOf(src);
  if (conv?.tool === "slack" && slackLinkType(conv) === "thread") add(extNode("slack", "thread", conv.id), "这条任务是从这个 Slack 线程来的");

  // ④ 正文里提到的工单号和页面地址。source.note 是口头交代的原话，
  //    source.description 是 Meegle 缺陷正文——复现步骤里的环境地址就在那儿，漏了等于白做
  const text = [task.title, task.understanding, task.plan, task.progress, src.note, src.description].filter(Boolean).join("\n");
  for (const id of workItemIdsIn(text)) if (id !== work?.id) add(extNode("meegle", "work_item", id), "任务正文里提到了这个工单号");
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
