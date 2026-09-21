import type { Project } from "../../memory/projects.js";
import type { Snapshot, SummonAction, SummonRules, Task } from "@friday/shared";
import { getTask } from "../../memory/tasks.js";
import { slackScene } from "./slack.js";

export interface MatchInput {
  snapshot: Snapshot;
  tasks: Task[];
  projects: Project[];
  channel?: string;
  person?: string;
}

export interface Candidate {
  task: Task;
  why: string;
  strength: "sure" | "maybe";
}

const SLACK_BUNDLE = "com.tinyspeck.slackmacgap";
const SLACK_SUFFIX = /\s*-\s*[^-]*-\s*Slack\s*$/;

// 中文界面的标题不带 # 而是跟一个「（频道）」后缀（team-fe-bo（频道） - Longbridge - Slack），
// 只按 # 开头判断会把整个频道当成人名，场景上下文全空，模型只能拿全局材料硬凑。
const CHANNEL_TAG = /\s*[（(](?:频道|channel)[）)]\s*$/i;

export function parseSlackTitle(title: string): { channel?: string; person?: string } {
  const head = title.replace(SLACK_SUFFIX, "").replace(/\s*\(\d+(?:\s+new items?)?\)\s*/i, "").trim();
  if (!head) return {};
  if (CHANNEL_TAG.test(head)) return { channel: head.replace(CHANNEL_TAG, "").trim() };
  return head.startsWith("#") ? { channel: head } : { person: head };
}

export function meegleIdFromUrl(url: string): string | undefined {
  return /\/(?:issue|story|detail)\/(?:detail\/)?(\d{3,})/.exec(url)?.[1];
}

export function projectByCwd(cwd: string, projects: Project[]): Project | undefined {
  let best: Project | undefined;
  for (const p of projects) {
    if (!p.dir) continue;
    if (cwd === p.dir || cwd.startsWith(`${p.dir}/`)) {
      if (!best || p.dir.length > best.dir.length) best = p;
    }
  }
  return best;
}

function projectByChannel(channel: string, projects: Project[]): Project | undefined {
  return projects.find((p) => p.channels.includes(channel));
}

export function candidates(input: MatchInput): Candidate[] {
  const { snapshot, tasks, projects, channel, person } = input;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (task: Task, why: string, strength: Candidate["strength"]) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    out.push({ task, why, strength });
  };

  const meegleId = snapshot.browser ? meegleIdFromUrl(snapshot.browser.url) : undefined;
  if (meegleId) for (const t of tasks) if (t.source.meegleId === meegleId) push(t, `你正开着这条工单 #${meegleId}`, "sure");

  if (snapshot.selection) {
    // 必须带 # 或工单类型前缀：裸的四位数字在日常文本里到处都是（年份、金额、行号），
    // 撞上某个 meegleId 就会把无关任务的不可逆待审动作送上 HUD 按钮，还标着「确定」
    const id = /(?:#|Defect|Issue|Story|Bug|工单|需求|缺陷)\s*[#-]?\s*(\d{3,})/i.exec(snapshot.selection)?.[1];
    if (id) for (const t of tasks) if (t.source.meegleId === id) push(t, `选中的文字里有工单号 #${id}`, "sure");
  }

  if (snapshot.app.bundleId === SLACK_BUNDLE && (channel || person)) {
    const scene = slackScene(channel, person);
    const task = scene?.taskId ? getTask(scene.taskId) : undefined;
    if (task) push(task, "这段 Slack 对话挂着这条任务", "sure");
  }

  if (channel) {
    const project = projectByChannel(channel, projects);
    if (project) for (const t of tasks) if (t.project === project.name) push(t, `${channel} 是 ${project.name} 的频道`, "maybe");
  }

  return out;
}

export function defaultActions(task: Task | undefined, project: Project | undefined, snapshot: Snapshot): SummonAction[] {
  if (!task) {
    const title = (snapshot.selection ?? snapshot.browser?.title ?? snapshot.app.title).slice(0, 60);
    return title ? [{ kind: "create_task", label: "建成任务", title }] : [];
  }
  const pending = task.pending?.[0];
  if (pending) {
    return [
      { kind: "approve_pending", label: pending.type === "slack_reply" ? "看一眼再发…" : "通过并执行", taskId: task.id, actionId: pending.id, pendingType: pending.type },
      { kind: "open_task", label: "打开任务", taskId: task.id },
    ];
  }
  if (task.status === "processing") {
    return [
      { kind: "open_task", label: "看进展", taskId: task.id },
      { kind: "mark_done", label: "标记完成", taskId: task.id },
    ];
  }
  const dir = project?.name ?? task.project;
  return dir
    ? [
        { kind: "start_work", label: "开工", project: dir, prompt: task.title },
        { kind: "open_task", label: "打开任务", taskId: task.id },
      ]
    : [{ kind: "open_task", label: "打开任务", taskId: task.id }];
}

function describe(snapshot: Snapshot, channel?: string): string {
  const bits = [snapshot.app.name];
  // 私聊解析出的是人名不是频道，原来会退到原始标题，
  // 把「(2) - Longbridge - Slack」这串未读数字和后缀也显示出来
  const slack = snapshot.app.bundleId === SLACK_BUNDLE ? parseSlackTitle(snapshot.app.title) : undefined;
  if (channel) bits.push(channel);
  else if (slack?.person) bits.push(slack.person);
  else if (snapshot.browser?.title) bits.push(snapshot.browser.title.slice(0, 60));
  else if (snapshot.app.title) bits.push(snapshot.app.title.slice(0, 60));
  if (snapshot.selection) bits.push(`选中了 ${snapshot.selection.length} 个字`);
  if (snapshot.screenshotPath) bits.push("截了一张图");
  return bits.join(" · ");
}

/** HUD 在 Slack 前台：帮我查这个 / 建成任务（只在没挂上时）/ 挂到…，零模型调用。 */
function slackActions(scene: ReturnType<typeof slackScene>): SummonAction[] | undefined {
  if (!scene) return undefined;
  const actions: SummonAction[] = [{ kind: "slack_query", label: "帮我查这个", conv: scene.conv }];
  if (!scene.taskId) actions.push({ kind: "slack_task", label: "建成任务", conv: scene.conv });
  actions.push({ kind: "slack_attach", label: "挂到…", conv: scene.conv });
  return actions;
}

export function buildRules(input: MatchInput): SummonRules {
  const hits = candidates(input);
  const top = hits[0];
  const project = top?.task.project ? input.projects.find((p) => p.name === top.task.project) : undefined;
  const scene = input.snapshot.app.bundleId === SLACK_BUNDLE ? slackScene(input.channel, input.person) : undefined;
  return {
    saw: describe(input.snapshot, input.channel),
    match: top ? { taskId: top.task.id, title: top.task.title, status: top.task.status, why: top.why, strength: top.strength } : undefined,
    actions: slackActions(scene) ?? defaultActions(top?.task, project, input.snapshot),
    // 模型永远跑：规则没命中恰恰是最该动脑的时候（这是什么、跟我哪件事有关）。
    // 以前没命中就闭嘴，用户只看到「我看到了 Chrome」加一个建任务按钮，那是登记表不是助理。
    willThink: true,
  };
}
