import { NEED_LABEL, STAGE_LABEL, TASK_STATUS_LABEL, type NeedKind, type Task } from "@friday/shared";
import { listMessages } from "../memory/conversations.js";
import { getJob } from "../memory/jobs.js";
import { getTask, listOpenBoardTasks } from "../memory/tasks.js";
import { autostartEnv, autostartPlan } from "./autostart.js";
import { contextFor } from "./bridge.js";
import { jobStateLabel } from "./sessionState.js";

const ROUTINE = new Set(["okr_weekly", "handbook", "project"]);
const BOARD_LIMIT = 6000;
const ONE_BLOCK_LIMIT = 2000;
const ALL_BLOCKS_LIMIT = 4000;

function clip(text: string, seq: number): string {
  if (text.length <= ONE_BLOCK_LIMIT) return text;
  const mark = `\n…（截断，task_get #${seq} 看全文）`;
  const cut = text.slice(0, ONE_BLOCK_LIMIT - mark.length);
  const nl = cut.lastIndexOf("\n");
  return (nl > 0 ? cut.slice(0, nl) : cut) + mark;
}

export function needOf(t: Task): { kind: NeedKind; key: string; reason: string } | undefined {
  if (ROUTINE.has(t.kind) || t.status === "done" || t.status === "ignored") return undefined;
  if (t.pending?.some((a) => a.type === "brief_approve")) return { kind: "brief", key: `brief:${t.source.brief?.at ?? t.id}`, reason: (t.plan ?? "").slice(0, 120) };
  if (t.status === "blocked") return { kind: "blocked", key: `blocked:${t.source.blockedAt ?? t.id}`, reason: t.progress ?? "" };
  if (t.attention === "question" || t.attention === "intake") return { kind: "blocked", key: `${t.attention}:${t.progress}`, reason: t.progress ?? "" };
  if (t.attention === "blocked") return { kind: "blocked", key: `blocked-attn:${t.progress}`, reason: t.progress ?? "" };
  const decide = t.pending?.find((a) => a.type === "reproject" || a.type === "discard_changes" || a.type === "start_job");
  if (decide) return { kind: "blocked", key: `decide:${decide.id}`, reason: `${decide.label}：${decide.detail.slice(0, 120)}` };
  if (t.attention === "review" && t.report && t.status === "processing") return { kind: "review", key: `review:${t.report.at}`, reason: t.report.summary };
  if (t.status === "review" && t.report) return { kind: "review", key: `review:${t.report.at}`, reason: t.report.summary };
  return undefined;
}

function waited(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} 小时` : `${Math.floor(h / 24)} 天`;
}

/** 一张卡此刻的完整内容：卡片本身 + 终端状态 + 要用户介入的提示 + 最近交付 */
function fullBlock(task: Task): string {
  const job = task.source.jobId ? getJob(task.source.jobId) : undefined;
  return [
    contextFor(task, job, "friday"),
    job ? `终端：${job.status === "running" ? jobStateLabel(job.id) : `进程已退出（退出码 ${job.exitCode ?? "?"}）`}${job.lastMessage ? `；它最后说：${job.lastMessage.slice(0, 200)}` : ""}` : "",
    task.attention === "blocked" ? "终端报告卡住了，需要用户介入。" : task.attention === "question" ? `终端正停在一个交互式提问上等用户回答（${task.progress ?? ""}）。用户说选哪个 / 怎么回，就用 terminal_say 把选项编号或文字敲进去，不要自己替用户选。` : task.attention === "intake" ? `你自己之前问过用户一句还没得到答复：${task.progress ?? ""}。用户一答就用 task_update 记下来（答的是项目归属就写 project），别再重复问。` : "",
    task.report ? `最近一次交付：${task.report.summary}（测试：${task.report.testResult}）${task.report.verify.length ? `；验证点用户已确认 ${(task.report.checked ?? []).filter(Boolean).length}/${task.report.verify.length}${(task.report.checked ?? []).filter(Boolean).length === task.report.verify.length ? "，全部通过" : ""}` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 每轮注入主对话系统提示的任务板：开着的任务各一行，刚聊过的给全文 */
export function boardBlock(conversationId: string, now = Date.now()): string {
  const env = autostartEnv(now);
  const rows = listOpenBoardTasks().map((t) => {
    const need = needOf(t)?.kind;
    const rank = need ? 0 : t.status === "processing" ? 1 : autostartPlan(t, env) ? 2 : 3;
    const state = need ? NEED_LABEL[need] : t.status === "processing" ? "在干" : rank === 2 ? "排队" : TASK_STATUS_LABEL[t.status];
    const line = ["#" + t.seq, t.project ?? "未定项目", t.title, t.stage && STAGE_LABEL[t.stage], state, waited(now - Date.parse(t.updatedAt))].filter(Boolean).join(" · ");
    return { rank, line };
  });
  rows.sort((a, b) => a.rank - b.rank);

  const ids = [...new Set(listMessages(conversationId).slice(-3).reverse().flatMap((m) => m.taskIds ?? []))];
  const blocks: string[] = [];
  let used = 0;
  for (const id of ids) {
    const t = getTask(id);
    if (!t) continue;
    const b = `#${t.seq} ${t.title}\n${clip(fullBlock(t), t.seq)}`;
    if (used + b.length + 2 > ALL_BLOCKS_LIMIT) break;
    blocks.push(b);
    used += b.length + 2;
  }
  const tail = blocks.length ? `\n\n【刚聊过的任务】\n${blocks.join("\n\n")}` : "";

  const head = (n: number, cut: number) => `【任务板】开着的 ${n} 条${cut ? `（超长，最后 ${cut} 条没列）` : ""}\n`;
  let keep = rows.length;
  const render = () => head(rows.length, rows.length - keep) + rows.slice(0, keep).map((r) => r.line).join("\n") + tail;
  while (keep > 0 && render().length > BOARD_LIMIT) keep--;
  return render();
}
