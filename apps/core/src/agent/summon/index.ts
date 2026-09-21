import type { Snapshot, SummonEvent } from "@friday/shared";
import { listTasks } from "../../memory/tasks.js";
import { loadProjects, type Project } from "../../memory/projects.js";
import { loadMemoryContext } from "../../memory/context.js";
import { personNote } from "../../memory/files.js";
import { userSettings } from "../../settings.js";
import { buildRules, candidates, parseSlackTitle } from "./match.js";
import { summonCard } from "./card.js";
import { slackScene, type SlackScene } from "./slack.js";
import { terminalContext } from "./terminal.js";

const SLACK_BUNDLE = "com.tinyspeck.slackmacgap";
const TERMINAL_BUNDLES = new Set(["com.mitchellh.ghostty", "com.googlecode.iterm2", "com.apple.Terminal"]);

/** Slack 这段对话最近说了什么、对方是谁，给模型判断用；查不到返回 undefined。 */
function slackContext(scene: SlackScene | undefined): string | undefined {
  if (!scene) return undefined;
  const note = personNote(scene.userName);
  const recent = scene.recent?.length
    ? [`频道 ${scene.channelName} 最近在聊：`, ...scene.recent.map((l) => `  ${l.userName}：${l.text}`)].join("\n")
    : "";
  return [`${scene.userName} 在 ${scene.channelName} 最近说：${scene.text}`, note ? `这个人：${note}` : "", recent].filter(Boolean).join("\n");
}

/** 终端 / Slack 这类场景专属上下文；对不上场景或解析不出就返回 undefined。 */
function sceneContext(snapshot: Snapshot, projects: Project[], scene: SlackScene | undefined): string | undefined {
  if (TERMINAL_BUNDLES.has(snapshot.app.bundleId)) return terminalContext(snapshot, projects);
  if (snapshot.app.bundleId === SLACK_BUNDLE) return slackContext(scene);
  return undefined;
}

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
  // projects.md 里登记过地址的项目自动进白名单：那些本来就是工作页面，
  // 用户登记过一次就不该再去设置里补一遍域名
  const projectHosts = loadProjects().flatMap((p) => p.urls.map((u) => u.split("/")[0]!).filter(Boolean));
  const snapshot = trimUrl(raw, [...userSettings().summon.urlAllowlist, ...projectHosts]);
  const tasks = listTasks(["collected", "understood", "processing", "review", "blocked"], 300);
  const projects = loadProjects();
  const { channel, person } = snapshot.app.bundleId === SLACK_BUNDLE ? parseSlackTitle(snapshot.app.title) : {};
  const slack = snapshot.app.bundleId === SLACK_BUNDLE ? await slackScene(channel, person) : undefined;
  const input = { snapshot, tasks, projects, channel, person, ...(slack ? { scene: slack } : {}) };
  const rules = buildRules(input);
  yield { type: "rules", rules };

  try {
    const scene = sceneContext(snapshot, projects, slack);
    const card = await summonCard({
      snapshot,
      rules,
      candidates: candidates(input),
      global: globalContext(),
      ...(scene ? { scene } : {}),
      ...(slack ? { slackConv: slack.conv } : {}),
    });
    yield { type: "card", card };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
  yield { type: "done" };
}
