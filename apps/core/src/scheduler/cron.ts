import { Cron } from "croner";

export const TZ = "Asia/Shanghai";
const LOOKBACK_MS = 8 * 24 * 3600_000;

const make = (cron: string) => new Cron(cron, { timezone: TZ, paused: true });

export function validateCron(cron: string): string | undefined {
  if (cron.trim().split(/\s+/).length !== 5) return "cron 要五段：分 时 日 月 周";
  try {
    make(cron);
    return undefined;
  } catch (e) {
    return `cron 写错了：${e instanceof Error ? e.message : String(e)}`;
  }
}

export function lastDue(cron: string, after: Date, now: Date): Date | undefined {
  const c = make(cron);
  let cur = c.nextRun(new Date(Math.max(after.getTime(), now.getTime() - LOOKBACK_MS)));
  let due: Date | undefined;
  while (cur && cur <= now) {
    due = cur;
    cur = c.nextRun(cur);
  }
  return due;
}

export function nextDue(cron: string, from = new Date()): Date | undefined {
  return make(cron).nextRun(from) ?? undefined;
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: string) => n.padStart(2, "0");

export function describeCron(cron: string): string {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!m || !h || !dom || !mon || !dow) return cron;
  if (mon !== "*") return cron;
  if (m === "*" && h === "*" && dom === "*" && dow === "*") return "每分钟";
  const every = /^\*\/(\d+)$/.exec(m);
  if (every && h === "*" && dom === "*" && dow === "*") return `每 ${every[1]} 分钟`;
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && dow === "*") return `每小时第 ${m} 分`;
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return cron;
  const at = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && dow === "*") return `每天 ${at}`;
  if (dom === "*" && dow === "1-5") return `工作日 ${at}`;
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) return `每周${dow.split(",").map((d) => WEEK[Number(d)]).join("、")} ${at}`;
  if (/^\d+$/.test(dom) && dow === "*") return `每月 ${dom} 日 ${at}`;
  return cron;
}
