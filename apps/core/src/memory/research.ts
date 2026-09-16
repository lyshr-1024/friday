import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/** 读一份研究笔记全文（记忆库相对路径）。「每天自学一题」已撤，只剩历史任务卡还要展开笔记。 */
export function readResearchNote(rel: string): string {
  try {
    return readFileSync(join(config.dataDir, rel), "utf8");
  } catch {
    return "";
  }
}
