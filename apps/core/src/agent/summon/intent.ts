/**
 * HUD 里说的话想干什么。
 *
 * 原来「帮我查这个 / 建成任务 / 挂到…」是三个按钮，点一下就是一个 HTTP 请求，零模型调用。
 * 按钮收起来改成对话触发之后，这条性质不能丢——所以先用正则认这几句常说的，
 * 认出来直接走原来那条路，认不出来才交给模型（在 relay 里落到通用对话）。
 *
 * 只认明确的说法，拿不准一律返回 undefined 让模型去判断：
 * 认错了会当着用户的面建一条任务或起一个后台查询，比没认出来烦人得多。
 */
export type SummonIntent = "slack_query" | "slack_task" | "slack_attach" | undefined;

/** 「帮我查一下」「查查这个」「读代码看看」——动词可以连着说两个（读代码 + 看看） */
const QUERY = /^(帮我|你)?(读一下代码|读代码|查一下|查查|查下|查一查|查|看一下|看看)(这个|这条|一下|看看|看一下)?(这个|这条|一下)?[，,。！!？?\s]*$/;

/** 「建成任务」「建个任务」「记成任务」「加到任务板」 */
const TASK = /(建|记|加)(成|个|一个|一条|条)?(任务|待办)|加到(任务板|板上)/;

/** 「挂到」「挂在」「关联到」——后面通常还跟任务名，所以不要求整句匹配 */
const ATTACH = /(挂到|挂在|挂上|关联到|关联上|并到|并入)/;

/**
 * 判断这句话是不是那三个动作之一。
 * 顺序有讲究：ATTACH 要排在 TASK 前面——「挂到那条任务上」同时含「任务」二字，
 * 先判 TASK 会把它误判成建任务，等于用户想挂靠却给他新建了一条。
 */
export function classifyIntent(text: string): SummonIntent {
  const s = text.trim();
  if (!s) return undefined;
  // 太长的多半是在交代事情而不是下指令（「挂到 X 上，另外顺便把 Y 也看一下……」），交给模型
  if (s.length > 30) return undefined;
  if (ATTACH.test(s)) return "slack_attach";
  if (TASK.test(s)) return "slack_task";
  if (QUERY.test(s)) return "slack_query";
  return undefined;
}
