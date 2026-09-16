import type { Snapshot, SummonEvent } from "@friday/shared";
import { listTasks } from "../../memory/tasks.js";
import { loadProjects } from "../../memory/projects.js";
import { loadMemoryContext } from "../../memory/context.js";
import { userSettings } from "../../settings.js";
import { buildRules, candidates, parseSlackTitle } from "./match.js";
import { summonCard } from "./card.js";

const SLACK_BUNDLE = "com.tinyspeck.slackmacgap";

/** Friday 本来就有这些，只是一直没往呼出这条链路送 */
function globalContext(): string {
  const mem = loadMemoryContext();
  const doing = listTasks(["processing", "review", "blocked"], 20);
  return [
    mem.projects ? `项目注册表：\n${mem.projects}` : "",
    mem.todos ? `今天要做的事：\n${mem.todos}` : "",
    doing.length
      ? `正在进行的：\n${doing.map((t) => `- ${t.title}（${t.status}${t.project ? ` · ${t.project}` : ""}）`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 白名单外的网址只留域名：设置页写着「只有这些域名会被记录与使用」，
 * 不接这条线的话用户银行、医疗、私人邮箱的完整 URL（含 query）都会进模型。
 */
export function trimUrl(snapshot: Snapshot, allowlist: string[]): Snapshot {
  if (!snapshot.browser) return snapshot;
  let host: string;
  try {
    host = new URL(snapshot.browser.url).hostname;
  } catch {
    return { ...snapshot, browser: { url: "", title: "" } };
  }
  if (allowlist.some((d) => host === d || host.endsWith(`.${d}`))) return snapshot;
  return { ...snapshot, browser: { url: host, title: "" } };
}

export async function* summon(raw: Snapshot): AsyncGenerator<SummonEvent> {
  const snapshot = trimUrl(raw, userSettings().summon.urlAllowlist);
  const tasks = listTasks(["collected", "understood", "processing", "review", "blocked"], 300);
  const projects = loadProjects();
  const { channel } = snapshot.app.bundleId === SLACK_BUNDLE ? parseSlackTitle(snapshot.app.title) : {};
  const input = { snapshot, tasks, projects, channel };
  const rules = buildRules(input);
  yield { type: "rules", rules };

  try {
    const card = await summonCard({ snapshot, rules, candidates: candidates(input), global: globalContext() });
    yield { type: "card", card };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
  yield { type: "done" };
}
