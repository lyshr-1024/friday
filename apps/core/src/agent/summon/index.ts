import type { Snapshot, SummonEvent } from "@friday/shared";
import { listTasks } from "../../memory/tasks.js";
import { loadProjects } from "../../memory/projects.js";
import { userSettings } from "../../settings.js";
import { buildRules, candidates, parseSlackTitle } from "./match.js";
import { summonCard } from "./card.js";

const SLACK_BUNDLE = "com.tinyspeck.slackmacgap";

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

  if (!rules.willThink) {
    yield { type: "done" };
    return;
  }

  try {
    const card = await summonCard({ snapshot, rules, candidates: candidates(input) });
    yield { type: "card", card };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
  yield { type: "done" };
}
