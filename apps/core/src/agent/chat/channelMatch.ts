import type { Task } from "@friday/shared";

/**
 * 阈值定在 6：7 字的「邀请达标不发奖」要能中，
 * 而「活动ai-agent大赛需求群」和「【AI 助理养成赛】」只共同 3 字是巧合，得挡掉。
 */
export const MIN_OVERLAP = 6;

const DROP = /[#【】[\]()（）·、,，。:：/\-_\s]/g;

function normalize(s: string): string {
  return s.replace(/^#/, "").replace(/^proj-/, "").replace(DROP, "").toLowerCase();
}

/** 频道名和任务标题的字面贴合度：最长公共子串长度。中文按字算。 */
export function overlapLen(channel: string, title: string): number {
  const a = [...normalize(channel)];
  const b = [...normalize(title)];
  if (!a.length || !b.length) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = (prev[j - 1] ?? 0) + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}

/** 频道对应哪条任务。共同子串太短是巧合（实测 3 字会误配），要够长才认。 */
export function matchChannelTask(channel: string, tasks: Task[]): { taskId: string; why: string } | undefined {
  let best: { taskId: string; title: string; n: number } | undefined;
  for (const t of tasks) {
    const n = overlapLen(channel, t.title);
    if (n < MIN_OVERLAP) continue;
    if (!best || n > best.n) best = { taskId: t.id, title: t.title, n };
  }
  return best ? { taskId: best.taskId, why: `频道名和需求「${best.title}」对得上 ${best.n} 个字` } : undefined;
}
