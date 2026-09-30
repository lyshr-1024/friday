import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Attachment, DeliveryReport } from "@friday/shared";
import { saveAttachment } from "../memory/attachments.js";
import { reportPath, shotsDir } from "./runner.js";

function section(md: string, title: string): string {
  const re = new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\r\\n]))`, "m");
  return re.exec(md)?.[1]?.trim() ?? "";
}
const bullets = (s: string) => s.split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);

/** 解析交付报告 Markdown；截图目录里的 png 存为附件。 */
export function parseReport(md: string, shots: Array<{ name: string; data: Buffer }> = []): DeliveryReport {
  return {
    summary: section(md, "概要") || "（报告缺少概要）",
    changes: bullets(section(md, "改动") || section(md, "依据")),
    testSteps: bullets(section(md, "测试")),
    testResult: section(md, "测试结果") || "（未写测试结果）",
    screenshots: shots.map((s) => saveAttachment(s.name, "image/png", s.data)),
    verify: bullets(section(md, "请验证")),
    at: new Date().toISOString(),
    ...(section(md, "回复草稿") ? { reply: section(md, "回复草稿") } : {}),
  };
}

/** 查询类任务给出的、可直接发给对方的一句回复 */
export function queryReplyDraft(report: DeliveryReport): string | undefined {
  const draft = report.reply?.trim();
  return draft ? draft.slice(0, 300) : undefined;
}

function readShots(jobId: string): Array<{ name: string; data: Buffer }> {
  const dir = shotsDir(jobId);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /\.png$/i.test(f))
        .sort()
        .map((f) => ({ name: f, data: readFileSync(join(dir, f)) }))
    : [];
}

export function collectReport(jobId: string): DeliveryReport | undefined {
  const p = reportPath(jobId);
  if (!existsSync(p)) return undefined;
  return parseReport(readFileSync(p, "utf8"), readShots(jobId));
}

/** friday_done 交付的报告里没有截图：退出时再把截图目录收成附件 */
export function collectShots(jobId: string): Attachment[] {
  return readShots(jobId).map((s) => saveAttachment(s.name, "image/png", s.data));
}
