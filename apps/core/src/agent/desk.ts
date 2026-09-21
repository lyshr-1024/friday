import type { Desk } from "@friday/shared";
import { askStream, SONNET_MODEL } from "./claude.js";
import { config } from "../config.js";
import { runningJobs } from "../memory/jobs.js";
import { listThreads } from "../memory/threads.js";
import { listOpenTodos } from "../memory/todos.js";
import { userSettings } from "../settings.js";

const CACHE_MS = 10 * 60_000;
let cache: { key: string; desk: Desk } | undefined;

function greeting(now = new Date()): string {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Shanghai" }).format(now)) % 24;
  return h < 6 ? "夜深了" : h < 12 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
}

/** 汇总等你回的人、到期待办、进行中的任务，让 Sonnet 写三五行“现在先做什么”。素材没变时 10 分钟内直接用缓存。 */
export async function buildDesk(): Promise<Desk> {
  const { name } = userSettings();
  const threads = listThreads("open")
    .filter((t) => t.brief?.needsReply)
    .sort((a, b) => rank(a.brief!.urgency) - rank(b.brief!.urgency) || Number(b.lastTs) - Number(a.lastTs))
    .slice(0, 6)
    .map((t) => ({ id: t.id, userName: t.userName, situation: t.brief!.situation, needs: t.brief!.needs, urgency: t.brief!.urgency }));
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  const todos = listOpenTodos()
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
    .slice(0, 8);
  const jobs = runningJobs();
  const key = JSON.stringify([threads.map((t) => t.id + t.situation), todos.map((t) => t.id), jobs.map((j) => j.id)]);
  if (cache && cache.key === key && Date.now() - new Date(cache.desk.generatedAt).getTime() < CACHE_MS) {
    return { ...cache.desk, greeting: greeting() };
  }

  const prompt = [
    `等回复的人（${threads.length}）：`,
    ...threads.map((t) => `- ${t.userName}［${t.urgency}］${t.situation}｜需要你：${t.needs}`),
    `待办（${todos.length}，今天 ${today}）：`,
    ...todos.map((t) => `- ${t.text}${t.due ? `（截止 ${t.due}${t.due < today ? "，已过期" : t.due === today ? "，今天" : ""}）` : ""}`),
    `进行中的终端任务（${jobs.length}）：`,
    ...jobs.map((j) => `- ${j.project}${j.task ? `：${j.task}` : ""}`),
  ].join("\n");
  let advice = "";
  try {
    for await (const ev of askStream(prompt, {
      systemPrompt: [
        "你是 Friday，用户的私人助理，用户是前端工程师。根据素材，用简体中文写“现在先做什么”：不超过 5 行纯文本，每行一件事，按紧急和阻塞别人的程度排序，直接给动作（回谁、先做哪件、哪个待办今天到期），不要寒暄、不要复述素材、不要 Markdown。素材为空就写一行“暂时没有等你的事，可以推进自己的项目”。",
        `现在是 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}。`,
      ].join("\n"),
      cwd: config.dataDir,
      model: SONNET_MODEL,
      label: "desk",
    })) {
      if (ev.type === "delta") advice += ev.text;
      if (ev.type === "reset") advice = "";
    }
  } catch (e) {
    advice = `（暂时没能生成建议：${e instanceof Error ? e.message : String(e)}）`;
  }
  const desk: Desk = { name, greeting: greeting(), advice: advice.trim(), threads, todos, jobs, generatedAt: new Date().toISOString() };
  cache = { key, desk };
  return desk;
}

const rank = (u: string) => (u === "high" ? 0 : u === "normal" ? 1 : 2);
