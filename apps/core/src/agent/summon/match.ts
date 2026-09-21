import type { Project } from "../../memory/projects.js";
import type { Snapshot, SummonAction, SummonRules, Task } from "@friday/shared";
import { getTask } from "../../memory/tasks.js";
import { matchProjectByUrl } from "../../memory/projects.js";
import type { SlackScene } from "./slack.js";

export interface MatchInput {
  snapshot: Snapshot;
  tasks: Task[];
  projects: Project[];
  channel?: string;
  person?: string;
  /** Slack 场景在 summon() 里算好一次传进来，规则层和卡片层共用，别各自重算 */
  scene?: SlackScene;
}

export interface Candidate {
  task: Task;
  why: string;
  strength: "sure" | "maybe";
}

const SLACK_BUNDLE = "com.tinyspeck.slackmacgap";
const SLACK_SUFFIX = /\s*-\s*[^-]*-\s*Slack\s*$/;

// 中文界面的标题不带 # 而是跟一个「（频道）」标记，它后面还可能挂别的段：
//   team-fe-bo（频道） - Longbridge - Slack
//   一起养牛（频道） - Longbridge - 1 个新项目 - Slack
// 所以不去数有几段后缀，直接认这个标记——它前面那截就是频道名。
const CHANNEL_TAG = /^(.+?)\s*[（(](?:频道|channel)[）)]/i;

// Slack 左侧那些视图（活动、私信、文件…）会整个占掉标题，它们不是人也不是频道，
// 认成人名只会让 Friday 去找一个叫「活动」的同事
const VIEWS = new Set(["活动", "私信", "文件", "主页", "更多", "草稿和已发送", "留待以后处理", "Activity", "DMs", "Files", "Home", "Later", "Drafts & sent"]);

export function parseSlackTitle(title: string): { channel?: string; person?: string } {
  const tagged = CHANNEL_TAG.exec(title);
  if (tagged) return { channel: tagged[1]!.trim() };
  const head = title.replace(SLACK_SUFFIX, "").replace(/\s*\(\d+(?:\s+new items?)?\)\s*/i, "").trim();
  if (!head || VIEWS.has(head)) return {};
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

/** 终端在跑 > 处理中 > 其余：越靠前越可能是此刻手上的活 */
const rank = (t: Task) => (t.source.jobId ? 4 : 0) + (t.status === "processing" ? 2 : 0) + (t.status === "review" ? 1 : 0);

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
    const task = input.scene?.taskId ? getTask(input.scene.taskId) : undefined;
    if (task) push(task, "这段 Slack 对话挂着这条任务", "sure");
  }

  if (channel) {
    const project = projectByChannel(channel, projects);
    if (project) for (const t of tasks) if (t.project === project.name) push(t, `${channel} 是 ${project.name} 的频道`, "maybe");
  }

  // 你开着某个项目的页面调试，那个项目上正跑着的活就是你手头的事。
  // 不接这条的话，只要 URL 不是工单页就一个候选都没有，HUD 只能另起一个终端——
  // 而你要的正是它已经开着的那个。
  const urlProject = snapshot.browser ? matchProjectByUrl([snapshot.browser.url], projects)?.name : undefined;
  if (urlProject) {
    const mine = tasks.filter((t) => t.project === urlProject);
    // 终端在跑的排前面：那才是此刻手上的活
    for (const t of [...mine].sort((a, b) => rank(b) - rank(a)))
      push(t, t.source.jobId ? `你开着 ${urlProject} 的页面，这条正在终端里跑` : `你开着 ${urlProject} 的页面`, "maybe");
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
function slackActions(scene: SlackScene | undefined): SummonAction[] | undefined {
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
  return {
    saw: describe(input.snapshot, input.channel),
    match: top ? { taskId: top.task.id, title: top.task.title, status: top.task.status, why: top.why, strength: top.strength } : undefined,
    actions: slackActions(input.scene) ?? defaultActions(top?.task, project, input.snapshot),
    // 模型永远跑：规则没命中恰恰是最该动脑的时候（这是什么、跟我哪件事有关）。
    // 以前没命中就闭嘴，用户只看到「我看到了 Chrome」加一个建任务按钮，那是登记表不是助理。
    willThink: true,
  };
}
