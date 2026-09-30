import type { Attachment, DeliveryReport, Task } from "@friday/shared";
import { addMessage, conversationExists } from "../memory/conversations.js";

const EMPTY = /^（.*）$/;

/**
 * Friday 自主任务 / 后台查询交付时写进任务会话的那条消息。任务卡上不再有交付报告，
 * 验收看的就是这条：做了什么、测得怎样、要你验哪几点，截图挂在下面。
 */
export function deliveryText(report: DeliveryReport, query = false): string {
  const lines = [`${query ? "查完了" : "交付了"}：${report.summary}`];
  if (report.testResult && !EMPTY.test(report.testResult)) lines.push(`测试结果：${report.testResult}`);
  if (query && report.changes.length) lines.push(["依据：", ...report.changes.map((c) => `- ${c}`)].join("\n"));
  if (report.verify.length) lines.push(["请你验证：", ...report.verify.map((v) => `- ${v}`)].join("\n"));
  return lines.join("\n");
}

export function postDelivery(task: Task, jobId: string, report: DeliveryReport): void {
  const conv = task.source.conversationId;
  if (!conv || !conversationExists(conv)) return;
  addMessage(conv, {
    role: "assistant",
    kind: "run",
    content: deliveryText(report, Boolean(task.source.headless)),
    payload: { status: "finished", jobId, ...(report.screenshots.length ? { attachments: report.screenshots } : {}) },
  });
}

/** friday_done 交付时截图还没收（它在退出时才收）：退出时补一条只带截图的消息 */
export function postShots(task: Task, jobId: string, shots: Attachment[]): void {
  const conv = task.source.conversationId;
  if (!shots.length || !conv || !conversationExists(conv)) return;
  addMessage(conv, { role: "assistant", kind: "run", content: `截图 ${shots.length} 张：`, payload: { status: "finished", jobId, attachments: shots } });
}
