import type { DeliveryReport } from "@friday/shared";

const EMPTY = /^（.*）$/;

/**
 * Friday 自主任务 / 后台查询交付时发进主对话的那条消息正文。任务卡上不再有交付报告，
 * 验收看的就是这条：做了什么、测得怎样、要你验哪几点，截图挂在下面。
 */
export function deliveryText(report: DeliveryReport, query = false): string {
  const lines = [`${query ? "查完了" : "交付了"}：${report.summary}`];
  if (report.testResult && !EMPTY.test(report.testResult)) lines.push(`测试结果：${report.testResult}`);
  if (query && report.changes.length) lines.push(["依据：", ...report.changes.map((c) => `- ${c}`)].join("\n"));
  if (report.decisions?.length) lines.push(["替你定了：", ...report.decisions.map((d) => `- ${d}`)].join("\n"));
  if (report.verify.length) lines.push(["请你验证：", ...report.verify.map((v) => `- ${v}`)].join("\n"));
  return lines.join("\n");
}
